const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  resolveStream: (url, audioOnly) => ipcRenderer.invoke('resolve-stream', url, audioOnly),
  download: (url, audioOnly) => ipcRenderer.invoke('download', url, audioOnly),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, pct) => cb(pct)),
  initThumbar: (icons) => ipcRenderer.send('thumbar-init', icons),
  setPlaybackState: (playing) => ipcRenderer.send('playback-state', playing),
  onMediaControl: (cb) => ipcRenderer.on('media-control', (_e, action) => cb(action))
});
