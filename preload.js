const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,

  // File & Folder Operations
  selectDownloadDir: () => ipcRenderer.invoke('select-download-dir'),
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  openFolder: (targetPath) => ipcRenderer.invoke('open-folder', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Notifications
  notify: (options) => ipcRenderer.invoke('show-notification', options),

  // Window Controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close')
});
