const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Text typing into other apps
  typeText: (text) => ipcRenderer.invoke('type-text', text),
  openAccessibilitySettings: () => ipcRenderer.invoke('open-accessibility-settings'),

  // Local Whisper transcription (runs in main process)
  transcribeLocal: (audioData, language) => ipcRenderer.invoke('transcribe-local', Array.from(audioData), language),

  // Whisper progress events
  onWhisperProgress: (callback) => {
    ipcRenderer.on('whisper-progress', (event, message, percent) => callback(message, percent));
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  setRecordingState: (state) => ipcRenderer.invoke('set-recording-state', state),
  captureSelection: () => ipcRenderer.invoke('capture-selection'),
  openWritingAssistant: () => ipcRenderer.invoke('open-writing-assistant'),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),
  enterMiniMode: () => ipcRenderer.invoke('enter-mini-mode'),
  exitMiniMode: () => ipcRenderer.invoke('exit-mini-mode'),
  toggleRecordingMain: () => ipcRenderer.invoke('toggle-recording-main'),

  // Events from main process
  onToggleRecording: (callback) => {
    ipcRenderer.on('toggle-recording', (event, isRecording) => callback(isRecording));
  },
  onTriggerAnalyze: (callback) => {
    ipcRenderer.on('trigger-analyze', () => callback());
  },

  onAppToast: (callback) => {
    ipcRenderer.on('app-toast', (_event, payload) => callback(payload));
  },
  
  // Custom Window Dragging (for cursor support on Windows)
  startDrag: (offset) => ipcRenderer.send('window-drag-start', offset),
  moveDrag: () => ipcRenderer.send('window-drag-move'),
  endDrag: () => ipcRenderer.send('window-drag-end')
});
