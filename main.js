const { app, BrowserWindow, ipcMain, nativeImage, dialog, clipboard } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Resolver work shouldn't compete with video playback for CPU
function deprioritize(p) {
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
}

// The standalone yt-dlp.exe self-extracts on first launch (and gets scanned
// by Defender), which is slow enough to stutter the app if it happens during
// the first drop. Pay that cost at startup instead.
function warmUpResolver() {
  const { cmd, baseArgs } = ytDlpCommand();
  const p = spawn(cmd, [...baseArgs, '--version'], { windowsHide: true });
  deprioritize(p);
  p.on('error', () => {});
}

// Bundled standalone yt-dlp binary: next to the app in dev (bin/), in
// resources/bin when packaged. Fall back to a Python install of yt-dlp.
function ytDlpCommand() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', binName),
    path.join(__dirname, 'bin', binName)
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return { cmd: c, baseArgs: [] }; } catch { /* keep looking */ }
  }
  return { cmd: isWin ? 'python' : 'python3', baseArgs: ['-m', 'yt_dlp'] };
}

// Resolve a YouTube page URL to direct stream URLs via yt-dlp.
// YouTube only offers 360p as a combined file, so prefer separate video+audio
// streams (up to 1080p); the renderer plays them through two synced elements.
// In audio-only mode a single audio stream is resolved instead.
function resolveStream(url, audioOnly) {
  return new Promise((resolve, reject) => {
    const { cmd, baseArgs } = ytDlpCommand();
    const format = audioOnly
      ? 'bestaudio[ext=m4a]/bestaudio'
      : 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[acodec!=none][vcodec!=none]/best';
    const args = [
      ...baseArgs,
      // Electron doubles as the Node runtime yt-dlp needs for JS challenges,
      // so target machines need nothing installed beyond this app.
      '--js-runtimes', `node:${process.execPath}`,
      '--remote-components', 'ejs:github',
      '--no-playlist',
      '-f', format,
      '-g',
      url
    ];
    const p = spawn(cmd, args, {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    deprioritize(p);
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      if (code === 0 && lines.length) {
        resolve({ video: lines[0], audio: lines[1] || null });
      } else {
        const msg = err.split(/\r?\n/).filter(l => l.includes('ERROR')).join(' ') || 'yt-dlp failed';
        reject(new Error(msg));
      }
    });
  });
}

ipcMain.handle('resolve-stream', (_e, url, audioOnly) => resolveStream(url, audioOnly));

// Merging separate video+audio streams into one file needs ffmpeg; without it
// downloads fall back to YouTube's combined format (~360p).
let ffmpegCheck = null;
function ffmpegAvailable() {
  if (!ffmpegCheck) {
    ffmpegCheck = new Promise(resolve => {
      const p = spawn('ffmpeg', ['-version'], { windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', code => resolve(code === 0));
    });
  }
  return ffmpegCheck;
}

// Download a video into the system Downloads folder, streaming progress
// percentages back to the renderer.
async function download(sender, url, audioOnly) {
  const { cmd, baseArgs } = ytDlpCommand();
  const format = audioOnly
    ? 'bestaudio[ext=m4a]/bestaudio'
    : (await ffmpegAvailable())
      ? 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[acodec!=none][vcodec!=none]/best'
      : 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best';
  const args = [
    ...baseArgs,
    '--js-runtimes', `node:${process.execPath}`,
    '--remote-components', 'ejs:github',
    '--no-playlist',
    '--no-mtime',
    '--newline',
    '-f', format,
    '-o', path.join(app.getPath('downloads'), '%(title)s.%(ext)s'),
    url
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    deprioritize(p);
    let err = '';
    p.stdout.on('data', d => {
      const m = String(d).match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m && !sender.isDestroyed()) sender.send('download-progress', Number(m[1]));
    });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(true);
      else reject(new Error(err.split(/\r?\n/).filter(l => l.includes('ERROR')).join(' ') || 'download failed'));
    });
  });
}

ipcMain.handle('download', (e, url, audioOnly) => download(e.sender, url, audioOnly));

// ---- In-app updates ----
// electron-updater reads latest.yml from the newest GitHub release. The
// renderer drives the flow: check on startup, download on click, then
// restart into the new installer.
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
// Background errors (offline, release without latest.yml) are reported to the
// renderer through the rejected IPC promises below; don't crash on the event.
autoUpdater.on('error', () => {});

ipcMain.handle('update-check', async () => {
  if (!app.isPackaged) return null; // unpacked dev runs have no update feed
  const res = await autoUpdater.checkForUpdates();
  return res && res.isUpdateAvailable ? res.updateInfo.version : null;
});

ipcMain.handle('update-download', e => {
  const onProgress = p => {
    if (!e.sender.isDestroyed()) e.sender.send('update-progress', p.percent);
  };
  autoUpdater.on('download-progress', onProgress);
  return autoUpdater
    .downloadUpdate()
    .finally(() => autoUpdater.removeListener('download-progress', onProgress));
});

ipcMain.on('update-install', () => autoUpdater.quitAndInstall());

// ---- Taskbar thumbnail toolbar (Windows) ----
// Prev / play-pause / next on the taskbar hover preview. The renderer draws
// the glyph icons on a canvas at startup and reports playback state; button
// clicks are forwarded back as media-control events.
let mainWin = null;
let thumbarIcons = null;

function setThumbar(playing) {
  if (process.platform !== 'win32' || !mainWin || mainWin.isDestroyed() || !thumbarIcons) return;
  const img = k => nativeImage.createFromDataURL(thumbarIcons[k]);
  const send = action => () => mainWin.webContents.send('media-control', action);
  mainWin.setThumbarButtons([
    { tooltip: 'Previous', icon: img('prev'), click: send('prev') },
    playing
      ? { tooltip: 'Pause', icon: img('pause'), click: send('playpause') }
      : { tooltip: 'Play', icon: img('play'), click: send('playpause') },
    { tooltip: 'Next', icon: img('next'), click: send('next') }
  ]);
}

ipcMain.on('thumbar-init', (_e, icons) => {
  thumbarIcons = icons;
  setThumbar(false);
});
ipcMain.on('playback-state', (_e, playing) => setThumbar(playing));

// The sandboxed preload has no clipboard access, so copying goes through here
ipcMain.on('copy-text', (_e, text) => clipboard.writeText(String(text)));

// ---- Custom background image ----
// The chosen image is copied into userData as background.<ext>; that file's
// existence is the whole persistence story.
function backgroundPath() {
  try {
    const dir = app.getPath('userData');
    const f = fs.readdirSync(dir).find(n => n.startsWith('background.'));
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

function removeBackgrounds() {
  const dir = app.getPath('userData');
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith('background.')) {
      try { fs.unlinkSync(path.join(dir, n)); } catch { /* locked file — ignore */ }
    }
  }
}

ipcMain.handle('bg-get', () => backgroundPath());

ipcMain.handle('bg-choose', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Choose a background image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return backgroundPath();
  removeBackgrounds();
  const src = r.filePaths[0];
  const dest = path.join(app.getPath('userData'), 'background' + path.extname(src).toLowerCase());
  fs.copyFileSync(src, dest);
  return dest;
});

ipcMain.handle('bg-clear', () => {
  removeBackgrounds();
  return null;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // When another window fully covers this one, Chromium treats the page as
      // hidden and pauses video elements that carry no audio track — which is
      // every >360p stream here, since audio plays through a separate element.
      backgroundThrottling: false
    }
  });
  win.loadFile('index.html');
  mainWin = win;
}

app.whenReady().then(() => {
  createWindow();
  warmUpResolver();
});

app.on('window-all-closed', () => app.quit());
