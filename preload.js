const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Text typing into other apps
  typeText: (text) => ipcRenderer.invoke('type-text', text),

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
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),

  // Events from main process
  onToggleRecording: (callback) => {
    ipcRenderer.on('toggle-recording', (event, isRecording) => callback(isRecording));
  },
  onTriggerAnalyze: (callback) => {
    ipcRenderer.on('trigger-analyze', () => callback());
  }
});
