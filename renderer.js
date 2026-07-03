// ---------- State ----------
let playlist = [];      // [{ id, url, title, thumb }]
let currentIndex = -1;
let savedPlaylists = [];  // [{ name, items, savedAt }]
let recentSessions = [];  // [{ items, endedAt }] — newest first, max 10
const MAX_RECENTS = 10;
const streamCache = new Map(); // videoId -> { streamUrl, at }
const STREAM_TTL_MS = 3 * 60 * 60 * 1000; // direct URLs expire, re-resolve after 3h

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
const saveNameInput = document.getElementById('saveName');

// ---------- Persistence ----------
function save() {
  localStorage.setItem('playlist', JSON.stringify(playlist));
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
  resolveItem(item).catch(() => {}); // resolve in the background, ready before play

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

// Replace the current queue with the given items (used by Saved and Recent)
function replaceQueue(items) {
  snapshotCurrentToRecents();
  playlist = items.map(it => ({ ...it }));
  currentIndex = -1;
  playToken++;
  stopMedia();
  nowTitle.textContent = 'Nothing playing';
  save();
  render();
  renderLibrary();
  if (playlist.length) play(0);
}

function saveCurrentPlaylist() {
  const name = saveNameInput.value.trim();
  if (!name) { setStatus('Enter a name first', true); return; }
  if (!playlist.length) { setStatus('Playlist is empty', true); return; }
  const items = playlist.map(it => ({ ...it }));
  const existing = savedPlaylists.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.items = items;
    existing.savedAt = Date.now();
    setStatus(`Updated "${name}"`);
  } else {
    savedPlaylists.unshift({ name, items, savedAt: Date.now() });
    setStatus(`Saved as "${name}"`);
  }
  saveNameInput.value = '';
  saveLibrary();
  renderLibrary();
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
      '<div class="empty">No saved playlists yet.<br>Build a queue, give it a name above and hit 💾.</div>';
  }
  savedPlaylists.forEach((p, i) => {
    savedListEl.appendChild(makeEntry({
      name: p.name,
      info: `${p.items.length} video${p.items.length === 1 ? '' : 's'}`,
      onOpen: () => replaceQueue(p.items),
      onDelete: () => {
        savedPlaylists.splice(i, 1);
        saveLibrary();
        renderLibrary();
      }
    }));
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

document.getElementById('saveBtn').addEventListener('click', saveCurrentPlaylist);
saveNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveCurrentPlaylist();
});

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
// Resolving via yt-dlp takes seconds, so it happens ahead of time: queued on
// drop and prefetched for the next track. Runs are serialized and deduped.
const pendingResolves = new Map(); // videoId -> Promise<streams>
let resolveChain = Promise.resolve();

function hasFreshStreams(id) {
  const c = streamCache.get(id);
  return !!c && Date.now() - c.at < STREAM_TTL_MS;
}

function resolveItem(item) {
  if (hasFreshStreams(item.id)) return Promise.resolve(streamCache.get(item.id).streams);
  if (pendingResolves.has(item.id)) return pendingResolves.get(item.id);
  const p = resolveChain
    .then(() => window.api.resolveStream(item.url))
    .then(streams => {
      streamCache.set(item.id, { streams, at: Date.now() });
      pendingResolves.delete(item.id);
      return streams;
    }, err => {
      pendingResolves.delete(item.id);
      throw err;
    });
  pendingResolves.set(item.id, p);
  resolveChain = p.catch(() => {});
  return p;
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
    streams = await resolveItem(item);
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

  // Prefetch the next track so skipping and auto-advance are instant
  const next = playlist[currentIndex + 1];
  if (next) resolveItem(next).catch(() => {});
}

function playNext() {
  if (currentIndex + 1 < playlist.length) play(currentIndex + 1);
  else stopMedia();
}
function playPrev() {
  if (currentIndex > 0) play(currentIndex - 1);
}

// Keep the audio element in sync with the video element
video.addEventListener('play', () => { if (hasSeparateAudio) audio.play().catch(() => {}); });
video.addEventListener('pause', () => { if (hasSeparateAudio) audio.pause(); });
video.addEventListener('waiting', () => { if (hasSeparateAudio) audio.pause(); });
video.addEventListener('playing', () => {
  if (hasSeparateAudio && !video.paused) {
    audio.currentTime = video.currentTime;
    audio.play().catch(() => {});
  }
});
video.addEventListener('seeked', () => { if (hasSeparateAudio) audio.currentTime = video.currentTime; });
video.addEventListener('volumechange', () => {
  audio.volume = video.volume;
  audio.muted = video.muted;
  updateVolumeUI();
  localStorage.setItem('volume', String(video.volume));
  localStorage.setItem('muted', video.muted ? '1' : '0');
});

// ---------- Volume controls ----------
// The video element carries no audio track when streams are separate, so its
// native volume control is disabled; this slider drives video.volume as the
// single source of truth and the listener above mirrors it to the audio element.
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
  if (hasSeparateAudio && !video.paused && !video.seeking &&
      Math.abs(audio.currentTime - video.currentTime) > 0.35) {
    audio.currentTime = video.currentTime;
  }
}, 500);

video.addEventListener('ended', playNext);

function handleMediaError() {
  if (!video.src) return;
  // Stale cached URL? Drop cache and retry once.
  const item = playlist[currentIndex];
  if (item && streamCache.has(item.id)) {
    streamCache.delete(item.id);
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
  if (!playlist.length) return;
  snapshotCurrentToRecents();
  renderLibrary();
  playlist = [];
  currentIndex = -1;
  playToken++;
  stopMedia();
  nowTitle.textContent = 'Nothing playing';
  save();
  render();
});

// ---------- Rendering ----------
function render() {
  listHead.textContent = `Playlist (${playlist.length})`;
  emptyHint.style.display = currentIndex === -1 ? 'flex' : 'none';
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

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '✕';
    rm.title = 'Remove';
    rm.addEventListener('click', e => { e.stopPropagation(); removeAt(i); });

    div.append(img, meta, rm);
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

// Keyboard shortcuts: space play/pause, N/P next/prev
document.addEventListener('keydown', e => {
  if (document.activeElement === urlInput) return;
  if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (e.key.toLowerCase() === 'n') playNext();
  else if (e.key.toLowerCase() === 'p') playPrev();
});

// ---------- Init ----------
load();
render();
renderLibrary();
