const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Bundled standalone yt-dlp.exe: next to the app in dev (bin/), in
// resources/bin when packaged. Fall back to a Python install of yt-dlp.
function ytDlpCommand() {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'yt-dlp.exe'),
    path.join(__dirname, 'bin', 'yt-dlp.exe')
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return { cmd: c, baseArgs: [] }; } catch { /* keep looking */ }
  }
  return { cmd: 'python', baseArgs: ['-m', 'yt_dlp'] };
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
