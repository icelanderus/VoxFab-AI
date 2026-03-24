const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grammarAPI', {
  onInit: (callback) => {
    ipcRenderer.on('grammar-init', (_e, payload) => callback(payload));
  },
  onAppearance: (callback) => {
    ipcRenderer.on('grammar-float-appearance', (_e, payload) => callback(payload));
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  runAiAction: (type, text, customInstruction) =>
    ipcRenderer.invoke('grammar-ai-action', { type, text, customInstruction }),
  applyPaste: (text) => ipcRenderer.invoke('type-text', text),
  close: () => ipcRenderer.invoke('grammar-float-close'),
  resize: (width, height) => ipcRenderer.send('grammar-float-resize', { width, height }),
  setFloatResizable: (enabled) =>
    ipcRenderer.send('grammar-float-set-resizable', { enabled: !!enabled }),
  startDrag: (offset) => ipcRenderer.send('window-drag-start', offset),
  moveDrag: () => ipcRenderer.send('window-drag-move'),
  endDrag: () => ipcRenderer.send('window-drag-end')
});
