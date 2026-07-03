const { app, BrowserWindow, ipcMain } = require('electron');
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
function resolveStream(url) {
  return new Promise((resolve, reject) => {
    const { cmd, baseArgs } = ytDlpCommand();
    const args = [
      ...baseArgs,
      // Electron doubles as the Node runtime yt-dlp needs for JS challenges,
      // so target machines need nothing installed beyond this app.
      '--js-runtimes', `node:${process.execPath}`,
      '--remote-components', 'ejs:github',
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[acodec!=none][vcodec!=none]/best',
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

ipcMain.handle('resolve-stream', (_e, url) => resolveStream(url));

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
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  warmUpResolver();
});

app.on('window-all-closed', () => app.quit());
