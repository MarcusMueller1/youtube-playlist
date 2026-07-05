// ---------- State ----------
let playlist = [];      // [{ id, url, title, thumb }]
let currentIndex = -1;
let savedPlaylists = [];  // [{ name, items, savedAt }]
let activePlaylist = null; // name of the saved playlist the queue is bound to (auto-saves)
let recentSessions = [];  // [{ items, endedAt }] — newest first, max 10
const MAX_RECENTS = 10;
const streamCache = new Map(); // streamKey(videoId) -> { streams, at }
const STREAM_TTL_MS = 3 * 60 * 60 * 1000; // direct URLs expire, re-resolve after 3h
let videoEnabled = localStorage.getItem('videoEnabled') !== '0'; // off = audio-only mode

const video = document.getElementById('video');
const audio = document.getElementById('audio');
const listEl = document.getElementById('list');
const listHead = document.getElementById('listHead');
const nowTitle = document.getElementById('nowTitle');
const statusEl = document.getElementById('status');
const emptyHint = document.getElementById('emptyHint');
const urlInput = document.getElementById('urlInput');
const savedListEl = document.getElementById('savedList');
const recentListEl = document.getElementById('recentList');
const newPlBtn = document.getElementById('newPlBtn');
const newPlName = document.getElementById('newPlName');

// ---------- Persistence ----------
function save() {
  localStorage.setItem('playlist', JSON.stringify(playlist));
  // The queue auto-saves into the playlist it's bound to
  const active = savedPlaylists.find(p => p.name === activePlaylist);
  if (active) {
    active.items = playlist.map(it => ({ ...it }));
    active.savedAt = Date.now();
    saveLibrary();
    renderLibrary();
  }
}
function setActivePlaylist(name) {
  activePlaylist = name;
  if (name) localStorage.setItem('activePlaylist', name);
  else localStorage.removeItem('activePlaylist');
}
function saveLibrary() {
  localStorage.setItem('savedPlaylists', JSON.stringify(savedPlaylists));
  localStorage.setItem('recentSessions', JSON.stringify(recentSessions));
}
function load() {
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  };
  playlist = read('playlist', []);
  savedPlaylists = read('savedPlaylists', []);
  recentSessions = read('recentSessions', []);
  const active = localStorage.getItem('activePlaylist');
  activePlaylist = savedPlaylists.some(p => p.name === active) ? active : null;
}

// ---------- Helpers ----------
function extractVideoId(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
      if (m) return m[2];
    }
  } catch { /* not a URL */ }
  return null;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

async function fetchTitle(pageUrl) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`
    );
    if (res.ok) return (await res.json()).title;
  } catch { /* offline or blocked — fall through */ }
  return pageUrl;
}

// ---------- Playlist operations ----------
async function addUrl(rawUrl) {
  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    setStatus('Not a YouTube video URL', true);
    return;
  }
  if (playlist.some(it => it.id === videoId)) {
    setStatus('Already in playlist');
    return;
  }
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const item = {
    id: videoId,
    url: pageUrl,
    title: 'Loading…',
    thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  };
  playlist.push(item);
  save();
  render();
  setStatus('Added');
  schedulePrefetch(item); // resolve in the background, ready before play

  // Title arrives async; patch it in place instead of re-rendering the list
  fetchTitle(pageUrl).then(title => {
    item.title = title;
    save();
    const titleEl = listEl.querySelector(`.item[data-id="${videoId}"] .title`);
    if (titleEl) titleEl.textContent = title;
    if (playlist[currentIndex] === item) nowTitle.textContent = title;
  });

}

function removeAt(i) {
  const wasCurrent = i === currentIndex;
  unschedulePrefetch(playlist[i].id);
  playlist.splice(i, 1);
  if (i < currentIndex) currentIndex--;
  else if (wasCurrent) {
    currentIndex = -1;
    playToken++;
    stopMedia();
    nowTitle.textContent = 'Nothing playing';
  }
  save();
  render();
}

function moveItem(from, to) {
  if (from === to) return;
  const [it] = playlist.splice(from, 1);
  playlist.splice(to, 0, it);
  if (currentIndex === from) currentIndex = to;
  else if (from < currentIndex && to >= currentIndex) currentIndex--;
  else if (from > currentIndex && to <= currentIndex) currentIndex++;
  save();
  render();
}

// ---------- Library: saved playlists & recent sessions ----------
function idsOf(items) {
  return items.map(it => it.id).join(',');
}

// Push the current queue into "Recent" — unless it's empty, matches a saved
// playlist, or is already the newest recent entry.
function snapshotCurrentToRecents() {
  if (!playlist.length) return;
  if (activePlaylist) return; // queue is bound to a saved playlist, nothing to lose
  const ids = idsOf(playlist);
  if (savedPlaylists.some(p => idsOf(p.items) === ids)) return;
  if (recentSessions.length && idsOf(recentSessions[0].items) === ids) {
    recentSessions[0].endedAt = Date.now();
  } else {
    recentSessions.unshift({ items: playlist.map(it => ({ ...it })), endedAt: Date.now() });
    recentSessions = recentSessions.slice(0, MAX_RECENTS);
  }
  saveLibrary();
}

// Replace the current queue with the given items (used by Saved and Recent).
// When `name` is set the queue is bound to that saved playlist and edits
// auto-save into it; recents open unbound.
function replaceQueue(items, name = null) {
  snapshotCurrentToRecents();
  setActivePlaylist(name);
  playlist = items.map(it => ({ ...it }));
  currentIndex = -1;
  playToken++;
  stopMedia();
  nowTitle.textContent = 'Nothing playing';
  save();
  render();
  renderLibrary();
  if (playlist.length) play(0);
  // Warm the whole queue so jumping to any track is instant, same as a
  // freshly dropped queue (play(0) already claimed the first item)
  prefetchQueue.length = 0;
  playlist.forEach(schedulePrefetch);
}

function createNewPlaylist(rawName) {
  const name = rawName.trim();
  if (!name) { setStatus('Enter a name first', true); return false; }
  if (savedPlaylists.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    setStatus(`"${name}" already exists`, true);
    return false;
  }
  snapshotCurrentToRecents();
  savedPlaylists.unshift({ name, items: [], savedAt: Date.now() });
  setActivePlaylist(name);
  playlist = [];
  currentIndex = -1;
  playToken++;
  stopMedia();
  nowTitle.textContent = 'Nothing playing';
  save();
  saveLibrary();
  render();
  renderLibrary();
  setStatus(`Created "${name}" — videos you add are saved to it`);
  return true;
}

function fmtWhen(ts) {
  return new Date(ts).toLocaleString(undefined, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function makeEntry({ name, info, onOpen, onDelete }) {
  const div = document.createElement('div');
  div.className = 'pentry';
  const meta = document.createElement('div');
  meta.className = 'pmeta';
  const nameEl = document.createElement('div');
  nameEl.className = 'pname';
  nameEl.textContent = name;
  const infoEl = document.createElement('div');
  infoEl.className = 'pinfo';
  infoEl.textContent = info;
  meta.append(nameEl, infoEl);
  const del = document.createElement('button');
  del.className = 'pdel';
  del.textContent = '✕';
  del.title = 'Delete';
  del.addEventListener('click', e => { e.stopPropagation(); onDelete(); });
  div.append(meta, del);
  div.addEventListener('click', onOpen);
  return div;
}

function renderLibrary() {
  savedListEl.innerHTML = '';
  if (!savedPlaylists.length) {
    savedListEl.innerHTML =
      '<div class="empty">No playlists yet.<br>Hit ＋ New playlist, name it, and every video you add is saved to it.</div>';
  }
  savedPlaylists.forEach((p, i) => {
    const entry = makeEntry({
      name: p.name,
      info: `${p.items.length} video${p.items.length === 1 ? '' : 's'}`,
      onOpen: () => replaceQueue(p.items, p.name),
      onDelete: () => {
        savedPlaylists.splice(i, 1);
        if (p.name === activePlaylist) setActivePlaylist(null);
        saveLibrary();
        renderLibrary();
        render();
      }
    });
    if (p.name === activePlaylist) entry.classList.add('active');
    savedListEl.appendChild(entry);
  });

  recentListEl.innerHTML = '';
  if (!recentSessions.length) {
    recentListEl.innerHTML =
      '<div class="empty">No recent sessions yet.<br>Unsaved playlists land here when you close the app or start a new queue.</div>';
  }
  recentSessions.forEach((s, i) => {
    const first = s.items[0] ? s.items[0].title : '';
    recentListEl.appendChild(makeEntry({
      name: `${fmtWhen(s.endedAt)} · ${s.items.length} video${s.items.length === 1 ? '' : 's'}`,
      info: first,
      onOpen: () => replaceQueue(s.items),
      onDelete: () => {
        recentSessions.splice(i, 1);
        saveLibrary();
        renderLibrary();
      }
    }));
  });
}

// "＋ New playlist" swaps to a name input; Enter creates, Escape/blur cancels
newPlBtn.addEventListener('click', () => {
  newPlBtn.hidden = true;
  newPlName.hidden = false;
  newPlName.value = '';
  newPlName.focus();
});
function closeNewPlaylistInput() {
  newPlName.hidden = true;
  newPlBtn.hidden = false;
}
newPlName.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (createNewPlaylist(newPlName.value)) closeNewPlaylistInput();
  } else if (e.key === 'Escape') {
    closeNewPlaylistInput();
  }
});
newPlName.addEventListener('blur', closeNewPlaylistInput);

// Collapsible library sidebar
const libToggle = document.getElementById('libToggle');
function setLibCollapsed(collapsed) {
  document.body.classList.toggle('lib-collapsed', collapsed);
  libToggle.textContent = collapsed ? '»' : '«';
  libToggle.title = collapsed ? 'Show library' : 'Hide library';
  localStorage.setItem('libCollapsed', collapsed ? '1' : '');
}
libToggle.addEventListener('click', () =>
  setLibCollapsed(!document.body.classList.contains('lib-collapsed')));
setLibCollapsed(!!localStorage.getItem('libCollapsed'));

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.getElementById('savedPane').hidden = tab.dataset.tab !== 'saved';
    document.getElementById('recentPane').hidden = tab.dataset.tab !== 'recent';
  });
});

// Capture the session when the app closes
window.addEventListener('beforeunload', snapshotCurrentToRecents);

// ---------- Stream resolution ----------
// Resolving via yt-dlp takes seconds, so it happens ahead of time: the whole
// queue prefetches in the background whenever it changes. Prefetches run one
// process at a time so they never swamp playback, but the track the user
// actually plays skips the queue and resolves immediately in parallel — it
// must never wait behind a pile of prefetches.
const pendingResolves = new Map(); // streamKey -> Promise<streams>
const prefetchQueue = [];          // items awaiting a background resolve
let prefetchBusy = false;

// Audio-only and video streams cache side by side, so toggling back is instant
function streamKey(id) {
  return `${id}:${videoEnabled ? 'av' : 'a'}`;
}

function hasFreshStreams(id) {
  const c = streamCache.get(streamKey(id));
  return !!c && Date.now() - c.at < STREAM_TTL_MS;
}

function resolveNow(item) {
  const key = streamKey(item.id);
  if (hasFreshStreams(item.id)) return Promise.resolve(streamCache.get(key).streams);
  if (pendingResolves.has(key)) return pendingResolves.get(key);
  const p = window.api.resolveStream(item.url, !videoEnabled).then(
    streams => {
      streamCache.set(key, { streams, at: Date.now() });
      pendingResolves.delete(key);
      return streams;
    },
    err => {
      pendingResolves.delete(key);
      throw err;
    }
  );
  pendingResolves.set(key, p);
  return p;
}

function schedulePrefetch(item) {
  if (!item) return;
  const key = streamKey(item.id);
  if (hasFreshStreams(item.id) || pendingResolves.has(key)) return;
  if (prefetchQueue.some(q => streamKey(q.id) === key)) return;
  prefetchQueue.push(item);
  pumpPrefetch();
}

function unschedulePrefetch(id) {
  for (let i = prefetchQueue.length - 1; i >= 0; i--) {
    if (prefetchQueue[i].id === id) prefetchQueue.splice(i, 1);
  }
}

function pumpPrefetch() {
  if (prefetchBusy) return;
  const item = prefetchQueue.shift();
  if (!item) return;
  prefetchBusy = true;
  resolveNow(item)
    .catch(() => {}) // play() retries on demand, with the error surfaced there
    .finally(() => { prefetchBusy = false; pumpPrefetch(); });
}

// ---------- Playback ----------
// YouTube serves >360p as separate video and audio streams; `audio` is a hidden
// element kept in lockstep with the visible `video` element.
let playToken = 0;
let hasSeparateAudio = false;

function stopMedia() {
  video.pause();
  audio.pause();
  video.removeAttribute('src');
  audio.removeAttribute('src');
  video.load();
  audio.load();
  hasSeparateAudio = false;
}

async function play(i) {
  if (i < 0 || i >= playlist.length) return;
  const item = playlist[i];
  currentIndex = i;
  render();
  nowTitle.textContent = item.title;

  const token = ++playToken;
  if (!hasFreshStreams(item.id)) setStatus('Resolving stream…');
  let streams;
  try {
    streams = await resolveNow(item);
  } catch (e) {
    if (token !== playToken) return;
    setStatus(`Failed: ${String(e.message || e).slice(0, 120)}`, true);
    return;
  }
  if (token !== playToken) return; // user clicked something else meanwhile

  setStatus('');
  stopMedia();
  hasSeparateAudio = !!streams.audio;
  video.src = streams.video;
  if (hasSeparateAudio) {
    audio.src = streams.audio;
    audio.volume = video.volume;
    audio.muted = video.muted;
  }
  video.play().catch(() => {});

  // Prefetch the next tracks so skipping and auto-advance are instant
  schedulePrefetch(playlist[currentIndex + 1]);
  schedulePrefetch(playlist[currentIndex + 2]);
}

function playNext() {
  if (currentIndex + 1 < playlist.length) play(currentIndex + 1);
  else stopMedia();
}
function playPrev() {
  if (currentIndex > 0) play(currentIndex - 1);
}

// Keep the audio element in sync with the video element.
// Never re-seek audio while it is still seeking: setting currentTime aborts
// the in-flight fetch and restarts it, which used to thrash for many seconds
// after a far seek. Let the running seek land, then correct any drift.
function resyncAudio() {
  if (hasSeparateAudio && !audio.seeking &&
      Math.abs(audio.currentTime - video.currentTime) > 0.35) {
    audio.currentTime = video.currentTime;
  }
}
video.addEventListener('play', () => { if (hasSeparateAudio) audio.play().catch(() => {}); });
video.addEventListener('pause', () => { if (hasSeparateAudio) audio.pause(); });
video.addEventListener('waiting', () => {
  if (hasSeparateAudio) audio.pause();
  if (!statusEl.textContent) setStatus('Buffering…');
});
video.addEventListener('playing', () => {
  if (statusEl.textContent === 'Buffering…') setStatus('');
  if (hasSeparateAudio && !video.paused) {
    resyncAudio();
    audio.play().catch(() => {});
  }
});
video.addEventListener('seeked', resyncAudio);
video.addEventListener('volumechange', () => {
  audio.volume = video.volume;
  audio.muted = video.muted;
  updateVolumeUI();
  localStorage.setItem('volume', String(video.volume));
  localStorage.setItem('muted', video.muted ? '1' : '0');
});

// ---------- Volume controls ----------
// This slider drives video.volume as the single source of truth; the
// volumechange listener above mirrors it to the separate audio element.
const volSlider = document.getElementById('volSlider');
const muteBtn = document.getElementById('muteBtn');

function updateVolumeUI() {
  volSlider.value = String(Math.round(video.volume * 100));
  muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
}

volSlider.addEventListener('input', () => {
  video.volume = Number(volSlider.value) / 100;
  if (video.volume > 0) video.muted = false;
});
muteBtn.addEventListener('click', () => {
  video.muted = !video.muted;
});

const storedVol = Number(localStorage.getItem('volume') ?? 1);
video.volume = Number.isFinite(storedVol) ? Math.min(1, Math.max(0, storedVol)) : 1;
video.muted = localStorage.getItem('muted') === '1';
updateVolumeUI();
video.addEventListener('ratechange', () => { audio.playbackRate = video.playbackRate; });
setInterval(() => {
  if (!video.paused && !video.seeking) resyncAudio();
}, 500);

video.addEventListener('ended', playNext);

// ---------- Video / audio-only toggle ----------
const videoToggleBtn = document.getElementById('videoToggle');
function updateVideoToggleUI() {
  videoToggleBtn.textContent = videoEnabled ? '🎬' : '🎵';
  videoToggleBtn.title = videoEnabled
    ? 'Video on — click for audio only'
    : 'Audio only — click to enable video';
  document.body.classList.toggle('audio-only', !videoEnabled);
}
videoToggleBtn.addEventListener('click', () => {
  videoEnabled = !videoEnabled;
  localStorage.setItem('videoEnabled', videoEnabled ? '1' : '0');
  updateVideoToggleUI();
  // Restart the current track in the new mode from the beginning, so the
  // separate video and audio streams can never start out of sync
  if (currentIndex !== -1 && video.src) play(currentIndex);
});
updateVideoToggleUI();

// ---------- Seek bar & time display ----------
// The video element has no native controls; this slider is the seek UI.
// While dragging, only the time label follows the thumb — the actual seek
// happens once on release, since every seek refetches from the network.
const seekSlider = document.getElementById('seekSlider');
const timeCur = document.getElementById('timeCur');
const timeDur = document.getElementById('timeDur');
let seekScrubbing = false;

function fmtTime(t) {
  if (!isFinite(t)) return '–:––';
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function scrubTime() {
  return (Number(seekSlider.value) / 1000) * video.duration;
}

video.addEventListener('timeupdate', () => {
  if (seekScrubbing) return;
  timeCur.textContent = fmtTime(video.currentTime);
  if (isFinite(video.duration) && video.duration > 0) {
    seekSlider.value = String(Math.round((video.currentTime / video.duration) * 1000));
  }
});
video.addEventListener('durationchange', () => {
  timeDur.textContent = fmtTime(video.duration);
});
video.addEventListener('emptied', () => {
  seekSlider.value = '0';
  timeCur.textContent = '0:00';
  timeDur.textContent = '0:00';
});
seekSlider.addEventListener('input', () => {
  if (!isFinite(video.duration) || !video.duration) { seekSlider.value = '0'; return; }
  seekScrubbing = true;
  timeCur.textContent = fmtTime(scrubTime());
});
// Seek both elements at once: the video needs seconds to re-buffer after a
// far seek, and the audio fetch should run during that wait, not after it
function seekTo(t) {
  video.currentTime = t;
  if (hasSeparateAudio) audio.currentTime = video.currentTime;
}

seekSlider.addEventListener('change', () => {
  if (seekScrubbing && isFinite(video.duration)) seekTo(scrubTime());
  seekScrubbing = false;
});

function seekBy(delta) {
  if (!video.src || !isFinite(video.duration)) return;
  seekTo(Math.min(video.duration, Math.max(0, video.currentTime + delta)));
}

// ---------- Download ----------
// Downloads go to the system Downloads folder; one at a time, progress in the
// status area. Video+audio merges to 1080p when ffmpeg is installed, else the
// main process falls back to YouTube's combined ~360p format.
const dlBtn = document.getElementById('dlBtn');
const dlMenu = document.getElementById('dlMenu');
let downloading = false;

dlBtn.addEventListener('click', () => {
  if (currentIndex === -1) { setStatus('Nothing playing', true); return; }
  dlMenu.hidden = !dlMenu.hidden;
});
document.addEventListener('click', e => {
  if (!e.target.closest('#dlWrap')) dlMenu.hidden = true;
});

dlMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', async () => {
    dlMenu.hidden = true;
    const item = playlist[currentIndex];
    if (!item) return;
    if (downloading) { setStatus('A download is already running'); return; }
    downloading = true;
    setStatus('Download starting…');
    try {
      await window.api.download(item.url, btn.dataset.mode === 'audio');
      setStatus('Saved to Downloads ✓');
    } catch (err) {
      setStatus(`Download failed: ${String(err.message || err).slice(0, 120)}`, true);
    } finally {
      downloading = false;
    }
  });
});

window.api.onDownloadProgress(pct => {
  if (downloading) setStatus(`Downloading… ${Math.round(pct)}%`);
});

// ---------- Taskbar thumbnail buttons (Windows) ----------
// The thumbnail toolbar needs bitmap icons; draw the media glyphs on a canvas
// so no image assets have to ship with the app.
function makeThumbIcon(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  draw(g);
  return c.toDataURL('image/png');
}
window.api.initThumbar({
  prev: makeThumbIcon(g => {
    g.fillRect(7, 8, 4, 16);
    g.beginPath(); g.moveTo(25, 8); g.lineTo(25, 24); g.lineTo(12, 16); g.closePath(); g.fill();
  }),
  play: makeThumbIcon(g => {
    g.beginPath(); g.moveTo(11, 7); g.lineTo(11, 25); g.lineTo(26, 16); g.closePath(); g.fill();
  }),
  pause: makeThumbIcon(g => {
    g.fillRect(9, 8, 5, 16);
    g.fillRect(18, 8, 5, 16);
  }),
  next: makeThumbIcon(g => {
    g.fillRect(21, 8, 4, 16);
    g.beginPath(); g.moveTo(7, 8); g.lineTo(7, 24); g.lineTo(20, 16); g.closePath(); g.fill();
  })
});
video.addEventListener('play', () => window.api.setPlaybackState(true));
video.addEventListener('pause', () => window.api.setPlaybackState(false));
window.api.onMediaControl(action => {
  if (action === 'prev') playPrev();
  else if (action === 'next') playNext();
  else togglePlay();
});

// ---------- Fullscreen & click-to-pause ----------
// Fullscreen the whole player pane so the control bar stays available.
const playerPane = document.getElementById('playerPane');
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else playerPane.requestFullscreen().catch(() => {});
}
document.getElementById('fsBtn').addEventListener('click', toggleFullscreen);
video.addEventListener('dblclick', toggleFullscreen);
video.addEventListener('click', () => { if (video.src) togglePlay(); });

function handleMediaError() {
  if (!video.src) return;
  // Stale cached URL? Drop cache and retry once.
  const item = playlist[currentIndex];
  if (item && streamCache.has(streamKey(item.id))) {
    streamCache.delete(streamKey(item.id));
    play(currentIndex);
  } else {
    setStatus('Playback error', true);
  }
}
video.addEventListener('error', handleMediaError);
audio.addEventListener('error', handleMediaError);

document.getElementById('nextBtn').addEventListener('click', playNext);
document.getElementById('prevBtn').addEventListener('click', playPrev);

const playBtn = document.getElementById('playBtn');
function togglePlay() {
  if (!video.src) {
    if (playlist.length) play(currentIndex === -1 ? 0 : currentIndex);
    return;
  }
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
playBtn.addEventListener('click', togglePlay);
video.addEventListener('play', () => { playBtn.textContent = '⏸'; });
video.addEventListener('pause', () => { playBtn.textContent = '▶'; });
document.getElementById('clearBtn').addEventListener('click', () => {
  if (!playlist.length && !activePlaylist) return;
  snapshotCurrentToRecents();
  // Detach before saving so clearing the queue never empties the saved playlist
  setActivePlaylist(null);
  prefetchQueue.length = 0;
  playlist = [];
  currentIndex = -1;
  playToken++;
  stopMedia();
  nowTitle.textContent = 'Nothing playing';
  save();
  render();
  renderLibrary();
});

// ---------- Rendering ----------
function render() {
  listHead.textContent = activePlaylist
    ? `${activePlaylist} (${playlist.length})`
    : `Playlist (${playlist.length})`;
  emptyHint.style.display = currentIndex === -1 ? 'flex' : 'none';
  document.body.classList.toggle('idle', currentIndex === -1);
  const scrollPos = listEl.scrollTop;
  listEl.innerHTML = '';
  playlist.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'item' + (i === currentIndex ? ' playing' : '');
    div.draggable = true;
    div.dataset.index = i;
    div.dataset.id = item.id;

    const img = document.createElement('img');
    img.src = item.thumb || '';
    img.draggable = false;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title;
    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = i === currentIndex ? '▶ now playing' : `#${i + 1}`;
    meta.append(title, idx);

    const cp = document.createElement('button');
    cp.className = 'copy';
    cp.textContent = '🔗';
    cp.title = 'Copy link';
    cp.addEventListener('click', e => {
      e.stopPropagation();
      window.api.copyText(item.url);
      setStatus('Link copied');
    });

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '✕';
    rm.title = 'Remove';
    rm.addEventListener('click', e => { e.stopPropagation(); removeAt(i); });

    div.append(img, meta, cp, rm);
    div.addEventListener('click', () => play(i));

    // Reorder within the list
    div.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/x-playlist-index', String(i));
      e.dataTransfer.effectAllowed = 'move';
    });
    div.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('application/x-playlist-index')) return;
      e.preventDefault();
      const rect = div.getBoundingClientRect();
      const below = e.clientY > rect.top + rect.height / 2;
      div.classList.toggle('dragover-above', !below);
      div.classList.toggle('dragover-below', below);
    });
    div.addEventListener('dragleave', () => {
      div.classList.remove('dragover-above', 'dragover-below');
    });
    div.addEventListener('drop', e => {
      const data = e.dataTransfer.getData('application/x-playlist-index');
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      const from = Number(data);
      const rect = div.getBoundingClientRect();
      const below = e.clientY > rect.top + rect.height / 2;
      let to = i + (below ? 1 : 0);
      if (from < to) to--;
      div.classList.remove('dragover-above', 'dragover-below');
      moveItem(from, to);
    });

    listEl.appendChild(div);
  });
  listEl.scrollTop = scrollPos;
}

// ---------- Drag & drop from browser ----------
let dragDepth = 0;
document.addEventListener('dragenter', e => {
  if (e.dataTransfer.types.includes('application/x-playlist-index')) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', e => {
  if (e.dataTransfer.types.includes('application/x-playlist-index')) return;
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer.types.includes('application/x-playlist-index')) return;

  const uriList = e.dataTransfer.getData('text/uri-list');
  const text = e.dataTransfer.getData('text/plain');
  const candidates = (uriList || text || '')
    .split(/[\r\n]+/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
  candidates.forEach(addUrl);
});

// ---------- Paste & manual input ----------
document.addEventListener('paste', e => {
  if (document.activeElement === urlInput) return;
  const text = e.clipboardData.getData('text/plain');
  if (text) addUrl(text);
});
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && urlInput.value.trim()) {
    addUrl(urlInput.value);
    urlInput.value = '';
  }
});

// Keyboard shortcuts: space play/pause, N/P next/prev, arrows seek, F fullscreen
// Clicked buttons/sliders keep focus and would swallow or double-handle keys;
// blur them so shortcuts always work after mouse interaction.
document.addEventListener('click', e => {
  if (e.target.matches('button, input[type="range"]')) e.target.blur();
});
document.addEventListener('keydown', e => {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'BUTTON')) return;
  if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (e.key.toLowerCase() === 'n') playNext();
  else if (e.key.toLowerCase() === 'p') playPrev();
  else if (e.key === 'ArrowRight') seekBy(5);
  else if (e.key === 'ArrowLeft') seekBy(-5);
  else if (e.key.toLowerCase() === 'f') toggleFullscreen();
});

// ---------- Custom background ----------
// The main process keeps the image in userData; here it gets painted onto
// <body>, dimmed so the UI stays readable, and the panels go translucent.
const bgBtn = document.getElementById('bgBtn');
const bgMenu = document.getElementById('bgMenu');

function applyBackground(p) {
  if (p) {
    // Same file name on every change, so cache-bust with a timestamp
    const url = encodeURI('file:///' + p.replace(/\\/g, '/')) + '?t=' + Date.now();
    document.body.style.backgroundImage =
      `linear-gradient(rgba(13, 15, 20, 0.4), rgba(13, 15, 20, 0.4)), url("${url}")`;
    document.body.classList.add('has-bg');
  } else {
    document.body.style.backgroundImage = '';
    document.body.classList.remove('has-bg');
  }
}

bgBtn.addEventListener('click', () => { bgMenu.hidden = !bgMenu.hidden; });
document.addEventListener('click', e => {
  if (!e.target.closest('#bgWrap')) bgMenu.hidden = true;
});
bgMenu.querySelector('[data-bg="choose"]').addEventListener('click', async () => {
  bgMenu.hidden = true;
  applyBackground(await window.api.chooseBackground());
});
bgMenu.querySelector('[data-bg="clear"]').addEventListener('click', async () => {
  bgMenu.hidden = true;
  applyBackground(await window.api.clearBackground());
});

window.api.getBackground().then(applyBackground);

// ---------- In-app updates ----------
// Check once on startup; the button walks through available → downloading →
// ready, and clicking in the ready state restarts into the new version.
const updateBtn = document.getElementById('updateBtn');
let updateState = 'idle';
let updateVersion = null;

window.api.onUpdateProgress(pct => {
  if (updateState === 'downloading') {
    updateBtn.textContent = `Downloading update… ${Math.round(pct)}%`;
  }
});

updateBtn.addEventListener('click', async () => {
  if (updateState === 'available') {
    updateState = 'downloading';
    updateBtn.disabled = true;
    updateBtn.textContent = 'Downloading update… 0%';
    try {
      await window.api.downloadUpdate();
      updateState = 'ready';
      updateBtn.textContent = '🔄 Restart to update';
    } catch {
      updateState = 'available';
      updateBtn.textContent = `⬆ Update to v${updateVersion} — retry`;
      setStatus('Update download failed', true);
    }
    updateBtn.disabled = false;
  } else if (updateState === 'ready') {
    window.api.installUpdate();
  }
});

(async () => {
  try {
    updateVersion = await window.api.checkForUpdate();
  } catch { /* offline or feed unreachable — try again next launch */ }
  if (updateVersion) {
    updateState = 'available';
    updateBtn.textContent = `⬆ Update to v${updateVersion}`;
    updateBtn.hidden = false;
  }
})();

// ---------- Init ----------
load();
render();
renderLibrary();
// Warm the restored queue in the background so the first click plays instantly
playlist.forEach(schedulePrefetch);
