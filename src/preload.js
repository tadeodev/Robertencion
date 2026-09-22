const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('parkour', {
  ready: () => ipcRenderer.send('player-ready'),
});
