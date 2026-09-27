// Narrow bridge between the Mac-style UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mx', {
  load: () => ipcRenderer.invoke('store:load'),
  save: (data) => ipcRenderer.invoke('store:save', data),
  feed: (handle) => ipcRenderer.invoke('feed:fetch', handle),
  prepare: (id) => ipcRenderer.invoke('session:prepare', id),
  signedIn: (id) => ipcRenderer.invoke('session:signedIn', id),
  clearSession: (id) => ipcRenderer.invoke('session:clear', id),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  close: () => ipcRenderer.invoke('win:close'),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  zoom: () => ipcRenderer.invoke('win:zoom'),
  quit: () => ipcRenderer.invoke('app:quit'),
  on: (channel, fn) => {
    if (!['shortcut', 'focus', 'zoomed'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
