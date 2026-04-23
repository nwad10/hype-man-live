const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getEnv: () => ipcRenderer.invoke('get-env'),
    getSources: () => ipcRenderer.invoke('get-sources')
});
