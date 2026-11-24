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
  setProcessingState: (state) => ipcRenderer.invoke('set-processing-state', state),
  getProcessingState: () => ipcRenderer.invoke('get-processing-state'),
  captureSelection: () => ipcRenderer.invoke('capture-selection'),
  /** Full-screen region snip → OpenAI vision OCR → resolves when done or cancelled */
  startRegionOcr: () => ipcRenderer.invoke('region-ocr'),
  openWritingAssistant: () => ipcRenderer.invoke('open-writing-assistant'),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),
  enterMiniMode: () => ipcRenderer.invoke('enter-mini-mode'),
  exitMiniMode: () => ipcRenderer.invoke('exit-mini-mode'),
  /** Docked edge tab (third collapsed mode). */
  enterEdgeTabMode: () => ipcRenderer.invoke('enter-edge-tab-mode'),
  /** true = pointer over the tab/button (take clicks); false = let clicks pass through. */
  edgeTabInteractive: (on) => ipcRenderer.send('edge-tab-interactive', on),
  /** phase: 'start' | 'move' | 'end' | 'cancel' */
  edgeTabDrag: (phase) => ipcRenderer.send('edge-tab-drag', phase),
  onEdgeTabEdge: (callback) => {
    ipcRenderer.on('edge-tab-edge', (_event, edge) => callback(edge));
  },
  toggleRecordingMain: () => ipcRenderer.invoke('toggle-recording-main'),
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  /** macOS packaged: null or { shortStatus, toast } when Intel build is running on Apple Silicon (Rosetta). */
  getMacosBinaryInstallIssue: () => ipcRenderer.invoke('get-macos-binary-install-issue'),

  disableGlobalShortcuts: () => ipcRenderer.invoke('disable-global-shortcuts'),
  enableGlobalShortcuts: () => ipcRenderer.invoke('enable-global-shortcuts'),

  // Events from main process
  /** macOS: Fn / lone modifier tap seen while the shortcut editor is open. */
  onNativeHotkeyCaptured: (callback) => {
    ipcRenderer.on('native-hotkey-captured', (_event, name) => callback(name));
  },
  /** Mic levels (0..1 per bar) from the recording window, forwarded to the mini FAB. */
  sendAudioLevels: (levels) => ipcRenderer.send('audio-levels', levels),
  onAudioLevels: (callback) => {
    ipcRenderer.on('audio-levels', (_event, levels) => callback(levels));
  },
  onToggleRecording: (callback) => {
    ipcRenderer.on('toggle-recording', (event, isRecording) => callback(isRecording));
  },
  onProcessingState: (callback) => {
    ipcRenderer.on('processing-state', (_event, isProcessing) => callback(isProcessing));
  },
  onTriggerAnalyze: (callback) => {
    ipcRenderer.on('trigger-analyze', () => callback());
  },

  onAppToast: (callback) => {
    ipcRenderer.on('app-toast', (_event, payload) => callback(payload));
  },
  onCollapsedAppearance: (callback) => {
    ipcRenderer.on('collapsed-appearance', (_event, payload) => callback(payload));
  },
  
  // Custom Window Dragging (for cursor support on Windows)
  startDrag: (offset) => ipcRenderer.send('window-drag-start', offset),
  moveDrag: () => ipcRenderer.send('window-drag-move'),
  endDrag: () => ipcRenderer.send('window-drag-end')
});
