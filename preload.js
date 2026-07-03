const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  resolveStream: (url) => ipcRenderer.invoke('resolve-stream', url)
});
