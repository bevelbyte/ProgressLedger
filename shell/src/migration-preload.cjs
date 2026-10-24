const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('migration', {
  selectDirectory: () => ipcRenderer.invoke('migration:select-dir'),
  start: (path) => ipcRenderer.invoke('migration:start', path),
  cancel: () => ipcRenderer.invoke('migration:cancel'),
  onProgress: (callback) => ipcRenderer.on('migration:progress', callback)
});
