const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionPickAPI', {
  onBootstrap: (cb) => {
    ipcRenderer.on('region-picker-bootstrap', (_e, payload) => cb(payload));
  },
  commit: (rect) => ipcRenderer.invoke('region-ocr-commit', rect),
  abort: () => ipcRenderer.invoke('region-ocr-abort')
});
