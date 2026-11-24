const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  clipboard,
  desktopCapturer,
  systemPreferences,
  dialog,
  net,
  shell
} = require('electron');
const { keyboard, Key, sleep } = require('@nut-tree-fork/nut-js');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

keyboard.config.autoDelayMs = 50;

// ============================================
// Simple JSON Config Store (replaces electron-store)
// ============================================
class ConfigStore {
  constructor(defaults = {}) {
    this.configPath = path.join(app.getPath('userData'), 'config.json');
    this.defaults = defaults;
    this.data = { ...defaults };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8').replace(/^\uFEFF/, '');
        this.data = { ...this.defaults, ...JSON.parse(raw) };
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  }

  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; this.save(); }
}

/** Initial main window size so the full UI (incl. bottom shortcuts) fits without scrolling. */
const DEFAULT_WINDOW_SIZE = { width: 440, height: 620 };
const LEGACY_DEFAULT_WINDOW_SIZE = { width: 340, height: 580 };

const store = new ConfigStore({
  engine: 'local-whisper',
  openaiApiKey: '',
  googleApiKey: '',
  autoType: true,
  autoDetectLanguage: true,
  translateToEnglish: false,
  windowPosition: null,
  windowSize: { ...DEFAULT_WINDOW_SIZE },
  /** One-time bump from LEGACY_DEFAULT_WINDOW_SIZE; avoids re-applying if user later chooses 340×580. */
  windowSizeLegacyDefaultUpgraded: false,
  bgOpacity: 1,
  bgBlur: 12,
  fabScale: 1,
  language: 'en',
  /** Win/Linux: open assistant when clipboard changes after copy. Default: false (user wants only explicit hotkeys). */
  autoGrammarClipboard: false,
  /** Allow dragging edges to resize the floating assistant window. */
  grammarFloatResizable: true,
  /** While recording, show interim text (Web Speech + periodic engine transcribe). Off by default (saves CPU/API). */
  livePreviewEnabled: false,
  /** Mic on/off + floating assistant UI sounds. */
  uiSoundsEnabled: true,
  /** Rewrite final dictation into clean sentences / numbered lists (OpenAI) before pasting. Off by default for maximum speed. */
  dictationCleanupEnabled: false,
  /** Selected audio input deviceId ('default' uses OS default microphone). */
  micDeviceId: 'default'
});

let mainWindow = null;
let grammarFloatWindow = null;
let aboutWindow = null;
/** Tiny always-on-top spinner near cursor while assistant payload loads (API scan). */
let grammarLoaderWindow = null;
let tray = null;
let isRecording = false;
let isProcessing = false;
let miniFabWindow = null;
/** Third collapsed mode: small tab docked to a screen edge. */
let edgeTabWindow = null;
let regionPickerWindow = null;
let regionOcrFlowResolve = null;
let regionOcrState = null;

let grammarClipboardIgnoreUntil = 0;
/** Last clipboard text seen by the watcher (change detection between polls). */
let prevClipboardTick = '';
let grammarFloatOpening = false;
let lastGrammarFloatPayloadText = '';
function markGrammarClipboardIgnore(ms = 3000) {
  grammarClipboardIgnoreUntil = Date.now() + ms;
}

/** PowerShell files must be on disk; external processes cannot open paths inside app.asar. */
function pathToScript(filename) {
  const rel = path.join('scripts', filename);
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', rel);
    if (fs.existsSync(unpacked)) return unpacked;
    console.error('Packaged app: expected unpacked script at', unpacked);
  }
  return path.join(__dirname, rel);
}

/** macOS process name for embedding in AppleScript (must not contain unescaped "). */
function escapeProcessNameForAppleScript(name) {
  if (!name || typeof name !== 'string' || name.length > 200) return '';
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runOsascriptInline(source) {
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-e', source], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => resolve({ ok: false, stderr: err.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
  });
}

/** No .scpt file on disk — works inside app.asar when launched from Dock. */
function macPasteAllInline(handle) {
  const safe = escapeProcessNameForAppleScript(handle);
  if (!safe) return Promise.resolve({ ok: false, stderr: 'invalid target' });
  const src = [
    'tell application "System Events"',
    `if not (exists process "${safe}") then error "Process not found"`,
    `tell process "${safe}"`,
    'set frontmost to true',
    'end tell',
    'delay 0.7',
    'keystroke "v" using command down',
    'end tell'
  ].join('\n');
  return runOsascriptInline(src);
}

function macFocusInline(handle) {
  const safe = escapeProcessNameForAppleScript(handle);
  if (!safe) return Promise.resolve({ ok: false, stderr: 'invalid target' });
  const src = [
    'tell application "System Events"',
    `if not (exists process "${safe}") then error "Process not found"`,
    `tell process "${safe}"`,
    'set frontmost to true',
    'end tell',
    'end tell'
  ].join('\n');
  return runOsascriptInline(src);
}

function macCopySelectionInline(handle) {
  const safe = escapeProcessNameForAppleScript(handle);
  if (!safe) return Promise.resolve({ ok: false, stderr: 'invalid target' });
  const src = [
    'tell application "System Events"',
    `if not (exists process "${safe}") then error "Process not found"`,
    `tell process "${safe}"`,
    'set frontmost to true',
    'end tell',
    'delay 0.12',
    'keystroke "c" using command down',
    'end tell'
  ].join('\n');
  return runOsascriptInline(src);
}

// Set App User Model ID for Windows Taskbar
if (process.platform === 'win32') {
  app.setAppUserModelId('com.icelanderus.voxfab-ai');
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const savedPosition = store.get('windowPosition');
  let savedSize = store.get('windowSize') || { ...DEFAULT_WINDOW_SIZE };
  const matchesLegacyDefault =
    savedSize.width === LEGACY_DEFAULT_WINDOW_SIZE.width &&
    savedSize.height === LEGACY_DEFAULT_WINDOW_SIZE.height;
  if (matchesLegacyDefault && !store.get('windowSizeLegacyDefaultUpgraded')) {
    savedSize = { ...DEFAULT_WINDOW_SIZE };
    store.set('windowSize', savedSize);
    store.set('windowSizeLegacyDefaultUpgraded', true);
  }
  const winWidth = savedSize.width;
  const winHeight = savedSize.height;

  const isWin = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 320,
    minHeight: 400,
    x: savedPosition ? savedPosition.x : screenWidth - winWidth - 20,
    y: savedPosition ? savedPosition.y : screenHeight - winHeight - 20,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Recording keeps running while this window is hidden (mini FAB); don't throttle its timers.
      backgroundThrottling: false
    },
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  });
  
  if (process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  mainWindow.loadFile('index.html');
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.setVisibleOnAllWorkspaces(true);

  // Save window state on move/resize
  const saveWindowState = () => {
    const [x, y] = mainWindow.getPosition();
    const [width, height] = mainWindow.getSize();
    store.set('windowPosition', { x, y });
    store.set('windowSize', { width, height });
  };

  mainWindow.on('moved', saveWindowState);
  mainWindow.on('resize', saveWindowState);

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.platform === 'darwin') {
    mainWindow.on('blur', () => {
      snapshotFrontmostPasteTarget();
    });
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          hideCollapsedWindows();
          mainWindow.show();
          if (process.platform === 'win32') {
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
          }
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Start/Stop Recording',
      click: () => {
        toggleRecording();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        mainWindow.removeAllListeners('close');
        app.quit();
      }
    }
  ]);

  tray.setToolTip('VoxFab AI');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      hideCollapsedWindows();
      mainWindow.show();
      if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
      mainWindow.focus();
    }
  });
}

function toggleRecording() {
  const prevRecording = isRecording;
  // Capture target app only when STARTING — on stop the frontmost app is often VoxFab itself.
  if (process.platform === 'darwin' && !prevRecording) {
    snapshotFrontmostPasteTarget();
  }
  isRecording = !isRecording;
  if (process.platform === 'darwin') {
    if (!prevRecording && isRecording) {
      macDuckPlaybackForRecordingStart();
    } else if (prevRecording && !isRecording) {
      macRestorePlaybackAfterRecordingStop();
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('toggle-recording', isRecording);
  }
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    syncMiniFabWidth();
    miniFabWindow.webContents.send('toggle-recording', isRecording);
  }
  if (edgeTabWindow && !edgeTabWindow.isDestroyed()) {
    placeEdgeTab();
    edgeTabWindow.webContents.send('toggle-recording', isRecording);
  }
}

// ============================================
// macOS single-key hotkeys (Fn, lone modifier taps)
// ============================================
// Electron's globalShortcut cannot register Fn or a bare modifier (e.g. Right ⌘) on macOS.
// A small JXA helper polls the HID keyboard state (no extra deps) and reports a "tap":
// key pressed and released with no other key or mouse click in between.
const MAC_SOLO_KEYS = {
  Fn: { flag: 0x800000 },
  LeftCommand: { code: 55 },
  RightCommand: { code: 54 },
  LeftOption: { code: 58 },
  RightOption: { code: 61 },
  LeftShift: { code: 56 },
  RightShift: { code: 60 },
  LeftCtrl: { code: 59 },
  RightCtrl: { code: 62 }
};

function isMacSoloHotkey(hk) {
  return process.platform === 'darwin' && typeof hk === 'string' && Object.prototype.hasOwnProperty.call(MAC_SOLO_KEYS, hk);
}

const MAC_KEY_WATCH_JXA = `
function run(argv) {
  ObjC.import('CoreGraphics');
  ObjC.bindFunction('getppid', ['int', []]);
  var watches = JSON.parse(argv[0]);
  var parent = $.getppid();
  var S = 1; // kCGEventSourceStateHIDSystemState
  function otherInput() {
    return $.CGEventSourceCounterForEventType(S, 10) + $.CGEventSourceCounterForEventType(S, 1) +
      $.CGEventSourceCounterForEventType(S, 3) + $.CGEventSourceCounterForEventType(S, 25);
  }
  var state = {};
  console.log('ready');
  var tick = 0;
  while (true) {
    var flags = $.CGEventSourceFlagsState(S);
    var other = otherInput();
    for (var i = 0; i < watches.length; i++) {
      var w = watches[i];
      var pressed = w.flag ? ((flags & w.flag) !== 0) : !!$.CGEventSourceKeyState(S, w.code);
      var st = state[w.name];
      if (pressed && !st) {
        state[w.name] = { t: Date.now(), other: other };
      } else if (!pressed && st) {
        state[w.name] = null;
        if (st.other === other && Date.now() - st.t < 1200) console.log('tap ' + w.name);
      }
    }
    if (++tick % 40 === 0 && $.getppid() !== parent) return;
    delay(0.025);
  }
}`;

let macKeyWatcher = null;
let macKeyWatcherSig = '';
/** name -> callback for the running watcher. */
let macKeyWatcherHandlers = {};

function stopMacKeyWatcher() {
  if (macKeyWatcher) {
    try {
      macKeyWatcher.kill();
    } catch (_) {}
  }
  macKeyWatcher = null;
  macKeyWatcherSig = '';
  macKeyWatcherHandlers = {};
}

/** handlers: { [soloKeyName]: () => void }. Empty object stops the watcher. */
function setMacKeyWatcher(handlers) {
  if (process.platform !== 'darwin') return;
  const names = Object.keys(handlers).filter((n) => MAC_SOLO_KEYS[n]).sort();
  const sig = names.join(',');
  if (!names.length) {
    stopMacKeyWatcher();
    return;
  }
  if (macKeyWatcher && sig === macKeyWatcherSig) {
    macKeyWatcherHandlers = handlers;
    return;
  }
  stopMacKeyWatcher();
  const watches = names.map((name) => ({ name, ...MAC_SOLO_KEYS[name] }));
  const proc = spawn('osascript', ['-l', 'JavaScript', '-e', MAC_KEY_WATCH_JXA, JSON.stringify(watches)]);
  macKeyWatcher = proc;
  macKeyWatcherSig = sig;
  macKeyWatcherHandlers = handlers;
  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('tap ')) {
        const fn = macKeyWatcherHandlers[line.slice(4)];
        if (typeof fn === 'function') {
          try {
            fn();
          } catch (e) {
            console.error('solo hotkey handler:', e);
          }
        }
      } else if (line && line !== 'ready') {
        console.error('key watcher:', line);
      }
    }
  });
  proc.on('error', (err) => console.error('key watcher spawn failed:', err.message));
  proc.on('exit', () => {
    if (macKeyWatcher === proc) {
      macKeyWatcher = null;
      macKeyWatcherSig = '';
    }
  });
}

/** While the shortcut editor is open: report any solo key tap to the renderer so Fn etc. can be recorded. */
function startMacHotkeyCaptureWatcher() {
  if (process.platform !== 'darwin') return;
  const handlers = {};
  for (const name of Object.keys(MAC_SOLO_KEYS)) {
    handlers[name] = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('native-hotkey-captured', name);
      }
    };
  }
  setMacKeyWatcher(handlers);
}

function registerGlobalShortcut() {
  const isMac = process.platform === 'darwin';
  globalShortcut.unregisterAll();

  // Load from store or use defaults
  const recordHotkey = store.get('recordHotkey') || (isMac ? 'Command+Shift+Space' : 'Ctrl+Shift+Space');
  const assistantHotkey = store.get('assistantHotkey') || (isMac ? 'Command+Shift+E' : 'Ctrl+Shift+E');
  const analyzeHotkey = store.get('analyzeHotkey') || (isMac ? 'Command+Alt+A' : 'Ctrl+Alt+A');

  const onToggleHotkey = () => {
    toggleRecording();
    
    // Only show main window if we are NOT in mini-fab mode
    const isMiniMode =
      (miniFabWindow && !miniFabWindow.isDestroyed() && miniFabWindow.isVisible()) ||
      (edgeTabWindow && !edgeTabWindow.isDestroyed() && edgeTabWindow.isVisible());
    
    if (!isMiniMode && mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }
  };

  const onAnalyzeHotkey = () => {
    if (mainWindow) {
      snapshotFrontmostPasteTarget();
      mainWindow.webContents.send('trigger-analyze');
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
    }
  };

  const onGrammarHotkey = () => {
    if (store.get('assistantEnabled') === false) return;
    openGrammarFloatFromShortcut().catch((e) => console.error('grammar float:', e));
  };

  // Single keys macOS can't register globally (Fn, lone modifiers) go through the HID watcher.
  const soloHandlers = {};
  const registerHotkey = (label, hk, handler) => {
    if (isMacSoloHotkey(hk)) {
      soloHandlers[hk] = handler;
      return;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(hk, handler);
    } catch (e) {
      console.error(`Invalid ${label}: ${hk}`, e.message);
    }
    if (!ok) console.error(`Failed to register ${label}: ${hk}`);
  };

  // Register Record
  registerHotkey('recordHotkey', recordHotkey, onToggleHotkey);
  // Register Assistant
  registerHotkey('assistantHotkey', assistantHotkey, onGrammarHotkey);
  setMacKeyWatcher(soloHandlers);
  // Register Analyze
  if (!globalShortcut.register(analyzeHotkey, onAnalyzeHotkey)) {
    console.error(`Failed to register analyzeHotkey: ${analyzeHotkey}`);
  }

  // Legacy/Fallback for Mac Ctrl vs Cmd if needed (optional, keeping minimal as requested)
  if (isMac && recordHotkey === 'Command+Shift+Space') {
    globalShortcut.register('Ctrl+Shift+Space', onToggleHotkey);
  }
}

// IPC Handlers
ipcMain.handle('get-settings', () => {
  return {
    version: app.getVersion(),
    engine: store.get('engine'),
    openaiApiKey: store.get('openaiApiKey'),
    googleApiKey: store.get('googleApiKey'),
    autoType: store.get('autoType'),
    autoDetectLanguage: store.get('autoDetectLanguage'),
    translateToEnglish: store.get('translateToEnglish'),
    language: store.get('language'),
    bgOpacity: store.get('bgOpacity'),
    bgBlur: store.get('bgBlur'),
    fabScale: store.get('fabScale') !== undefined ? store.get('fabScale') : 1,
    assistantEnabled: store.get('assistantEnabled') !== false,
    grammarFloatResizable: store.get('grammarFloatResizable') !== false,
    livePreviewEnabled: store.get('livePreviewEnabled') === true,
    uiSoundsEnabled: store.get('uiSoundsEnabled') !== false,
    dictationCleanupEnabled: store.get('dictationCleanupEnabled') === true,
    micDeviceId: store.get('micDeviceId') || 'default',
    recordHotkey: store.get('recordHotkey') || (process.platform === 'darwin' ? 'Command+Shift+Space' : 'Ctrl+Shift+Space'),
    assistantHotkey: store.get('assistantHotkey') || (process.platform === 'darwin' ? 'Command+Shift+E' : 'Ctrl+Shift+E')
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  if (settings.engine !== undefined) store.set('engine', settings.engine);
  if (settings.openaiApiKey !== undefined) store.set('openaiApiKey', settings.openaiApiKey);
  if (settings.googleApiKey !== undefined) store.set('googleApiKey', settings.googleApiKey);
  if (settings.autoType !== undefined) store.set('autoType', settings.autoType);
  if (settings.autoDetectLanguage !== undefined) store.set('autoDetectLanguage', settings.autoDetectLanguage);
  if (settings.translateToEnglish !== undefined) store.set('translateToEnglish', settings.translateToEnglish);
  if (settings.language !== undefined) store.set('language', settings.language);
  if (settings.bgOpacity !== undefined) {
    store.set('bgOpacity', settings.bgOpacity);
    broadcastGrammarFloatAppearance();
    broadcastCollapsedAppearance();
  }
  if (settings.bgBlur !== undefined) store.set('bgBlur', settings.bgBlur);
  if (settings.fabScale !== undefined) {
    store.set('fabScale', settings.fabScale);
    broadcastCollapsedAppearance();
  }
  if (settings.assistantEnabled !== undefined) {
    store.set('assistantEnabled', settings.assistantEnabled);
    if (!settings.assistantEnabled) {
      if (grammarFloatWindow && !grammarFloatWindow.isDestroyed()) {
        grammarFloatWindow.hide();
      }
    }
  }
  if (settings.grammarFloatResizable !== undefined) {
    store.set('grammarFloatResizable', settings.grammarFloatResizable);
    applyGrammarFloatResizable();
  }
  if (settings.livePreviewEnabled !== undefined) {
    store.set('livePreviewEnabled', settings.livePreviewEnabled);
  }
  if (settings.uiSoundsEnabled !== undefined) {
    store.set('uiSoundsEnabled', settings.uiSoundsEnabled);
  }
  if (settings.dictationCleanupEnabled !== undefined) {
    store.set('dictationCleanupEnabled', settings.dictationCleanupEnabled);
  }
  if (settings.micDeviceId !== undefined) {
    store.set('micDeviceId', settings.micDeviceId || 'default');
  }
  if (settings.recordHotkey !== undefined || settings.assistantHotkey !== undefined) {
    if (settings.recordHotkey !== undefined) store.set('recordHotkey', settings.recordHotkey);
    if (settings.assistantHotkey !== undefined) store.set('assistantHotkey', settings.assistantHotkey);
    registerGlobalShortcut();
  }
  return true;
});

ipcMain.handle('disable-global-shortcuts', () => {
  globalShortcut.unregisterAll();
  startMacHotkeyCaptureWatcher();
  return true;
});

ipcMain.handle('enable-global-shortcuts', () => {
  registerGlobalShortcut();
  return true;
});

ipcMain.handle('enter-mini-mode', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  ensureMiniFabWindow();
  if (miniFabWindow) {
    syncMiniFabWidth();
    miniFabWindow.show();
    // Immediate sync of recording state to the FAB
    miniFabWindow.webContents.send('toggle-recording', isRecording);
    miniFabWindow.webContents.send('processing-state', isProcessing);
    miniFabWindow.webContents.send('collapsed-appearance', {
      bgOpacity: grammarFloatBgOpacityOrDefault(),
      fabScale: getFabScaleOrDefault()
    });
  }
  return true;
});

ipcMain.handle('exit-mini-mode', () => {
  hideCollapsedWindows();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (process.platform === 'win32') {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
    mainWindow.focus();
  }
  return true;
});

// Custom Window Dragging for Cursor Support
let activeDragWin = null;
let dragOffset = { x: 0, y: 0 };

ipcMain.on('window-drag-start', (event, offset) => {
  activeDragWin = BrowserWindow.fromWebContents(event.sender);
  if (activeDragWin && !activeDragWin.isDestroyed()) {
    const pt = screen.getCursorScreenPoint();
    const [wx, wy] = activeDragWin.getPosition();
    dragOffset = { x: pt.x - wx, y: pt.y - wy };
  } else {
    dragOffset = offset;
  }
});

ipcMain.on('window-drag-move', (event) => {
  if (activeDragWin && !activeDragWin.isDestroyed()) {
    const { x, y } = screen.getCursorScreenPoint();
    activeDragWin.setPosition(x - Math.round(dragOffset.x), y - Math.round(dragOffset.y));
  }
});

ipcMain.on('window-drag-end', () => {
  activeDragWin = null;
});

// Track the last externally focused window
let lastExternalWindowHandle = null;
let lastExternalWindowName = null;
const { spawn, exec, spawnSync } = require('child_process');

const OUR_PROCESS_NAMES = new Set(['Electron', 'VoxFab AI']);

/** macOS: saved system volume while output is muted during voice recording (restore on stop / quit). */
let macPlaybackDuckSaved = null;

/** Mute system speaker/headphone output during recording so background music does not leak into the mic. */
function macDuckPlaybackForRecordingStart() {
  if (process.platform !== 'darwin' || macPlaybackDuckSaved) return;
  const src = [
    'set vs to get volume settings',
    'set ov to output volume of vs',
    'set om to output muted of vs',
    'set volume with output muted',
    'return (ov as text) & "|" & (om as text)'
  ].join('\n');
  try {
    const r = spawnSync('osascript', ['-e', src], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) return;
    const out = (r.stdout || '').trim();
    const parts = out.split('|');
    if (parts.length !== 2) return;
    const vol = parseInt(parts[0], 10);
    if (!Number.isFinite(vol)) return;
    macPlaybackDuckSaved = {
      outputVolume: vol,
      outputMuted: parts[1] === 'true'
    };
  } catch (e) {
    console.error('macDuckPlaybackForRecordingStart:', e.message);
  }
}

function macRestorePlaybackAfterRecordingStop() {
  if (process.platform !== 'darwin' || !macPlaybackDuckSaved) return;
  const saved = macPlaybackDuckSaved;
  macPlaybackDuckSaved = null;
  const v = Math.max(0, Math.min(100, Math.round(Number(saved.outputVolume) || 0)));
  const muteLine = saved.outputMuted ? 'set volume with output muted' : 'set volume without output muted';
  const src = `set volume output volume ${v}\n${muteLine}`;
  try {
    spawnSync('osascript', ['-e', src], { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    console.error('macRestorePlaybackAfterRecordingStop:', e.message);
  }
}

/** macOS: remember which app was frontmost when the user pressed a global shortcut (before our window may steal focus). */
function snapshotFrontmostPasteTarget() {
  if (process.platform !== 'darwin') return;
  try {
    const r = spawnSync(
      'osascript',
      ['-e', 'tell application "System Events" to return name of first process whose frontmost is true'],
      { encoding: 'utf8', timeout: 3000 }
    );
    const name = (r.stdout || '').trim();
    if (name && !OUR_PROCESS_NAMES.has(name)) {
      lastExternalWindowHandle = name;
      lastExternalWindowName = name;
    }
  } catch (e) {
    console.error('snapshotFrontmostPasteTarget:', e.message);
  }
}

/**
 * Packaged macOS: Intel (x64) binary running on Apple Silicon under Rosetta often breaks mic/MediaRecorder.
 * Return a short hint for the renderer so we do not blame "recording too short".
 */
function getMacosBinaryInstallIssue() {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  if (process.arch !== 'x64') return null;
  try {
    const r = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 2000 });
    if (r.error || r.status !== 0) return null;
    if (String(r.stdout || '').trim() !== '1') return null;
  } catch {
    return null;
  }
  return {
    shortStatus: 'Wrong build: Intel app on Apple Silicon',
    toast:
      'You installed the Intel (x64) DMG on an Apple Silicon Mac. This copy runs under Rosetta and microphone capture often fails. Remove it and install the Apple Silicon (M1/M2/M3) DMG instead.'
  };
}

ipcMain.handle('get-macos-binary-install-issue', () => getMacosBinaryInstallIssue());

ipcMain.handle('capture-selection', async () => {
  markGrammarClipboardIgnore(3200);
  const snapshot = clipboardSnapshot();

  try {
    const isWin = process.platform === 'win32';
    const handle = lastExternalWindowHandle || (isWin ? '0' : '');
    const scriptPath = isWin ? pathToScript('copy-selection.ps1') : pathToScript('macos-copy.scpt');

    if (isWin) {
      await new Promise((resolve) => {
        exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -TargetHandle "${handle}"`, { windowsHide: true }, (error) => {
          if (error) console.error('PowerShell Copy Error:', error);
          resolve();
        });
      });
    } else {
      exec(
        `osascript -e 'tell application "${handle}" to activate' -e 'tell application "System Events" to keystroke "c" using command down'`
      );
      await new Promise((r) => setTimeout(r, 400));
    }

    const resolved = await resolveClipboardAfterCopy(snapshot);
    clipboardRestoreSnapshot(snapshot);
    try {
      prevClipboardTick = (snapshot.text || '').trim();
    } catch (_) {}

    const ctx = lastExternalWindowName || lastExternalWindowHandle;
    if (resolved.text && resolved.text.trim()) {
      return {
        text: resolved.text.trim(),
        windowContext: ctx,
        source: resolved.source
      };
    }
    return {
      text: '',
      windowContext: ctx,
      source: resolved.source,
      errorKey: resolved.errorKey || 'empty'
    };
  } catch (error) {
    console.error('Capture selection failed:', error);
    clipboardRestoreSnapshot(snapshot);
    try {
      prevClipboardTick = (snapshot.text || '').trim();
    } catch (_) {}
    return { text: '', windowContext: null, source: 'none', errorKey: 'exception' };
  }
});

ipcMain.handle('region-ocr', async () => {
  if (regionOcrFlowResolve || regionOcrState || regionPickerWindow) {
    return { ok: false, errorKey: 'busy' };
  }
  if (!store.get('openaiApiKey')) {
    return { ok: false, errorKey: 'no-api-key' };
  }

  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const bounds = display.bounds;
  const sf = display.scaleFactor || 1;
  const tw = Math.min(4096, Math.max(1, Math.round(bounds.width * sf)));
  const th = Math.min(4096, Math.max(1, Math.round(bounds.height * sf)));

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: tw, height: th }
    });
  } catch (e) {
    console.error('desktopCapturer.getSources:', e);
    return { ok: false, errorKey: 'capture-failed' };
  }

  if (!sources || !sources.length) {
    return { ok: false, errorKey: 'capture-failed' };
  }

  const idStr = String(display.id);
  let source = sources.find((s) => s.display_id === idStr);
  if (!source) {
    const all = screen.getAllDisplays();
    const di = all.findIndex((d) => d.id === display.id);
    if (di >= 0 && sources[di]) source = sources[di];
  }
  if (!source) source = sources[0];

  const fullImage = source.thumbnail;
  if (!fullImage || fullImage.isEmpty()) {
    return { ok: false, errorKey: 'capture-failed' };
  }

  const tmpPath = path.join(app.getPath('temp'), `voxfab-region-${Date.now()}.png`);
  try {
    fs.writeFileSync(tmpPath, fullImage.toPNG());
  } catch (e) {
    console.error('region temp png:', e);
    return { ok: false, errorKey: 'capture-failed' };
  }

  return new Promise((resolve) => {
    regionOcrFlowResolve = resolve;
    regionOcrState = { fullImage, tmpPath };

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      useContentSize: true,
      frame: false,
      transparent: false,
      backgroundColor: '#0f172a',
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'region-picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    if (process.platform === 'darwin') {
      win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      win.setAlwaysOnTop(true, 'floating');
    }

    regionPickerWindow = win;

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });

    win.on('closed', () => {
      regionPickerWindow = null;
      try {
        if (regionOcrState && regionOcrState.tmpPath && fs.existsSync(regionOcrState.tmpPath)) {
          fs.unlinkSync(regionOcrState.tmpPath);
        }
      } catch (_) {}
      if (regionOcrFlowResolve) {
        regionOcrFlowResolve({ ok: false, errorKey: 'cancelled' });
        regionOcrFlowResolve = null;
      }
      regionOcrState = null;
    });

    win.loadFile(path.join(__dirname, 'region-picker.html'));

    win.webContents.once('did-finish-load', () => {
      const sz = fullImage.getSize();
      win.webContents.send('region-picker-bootstrap', {
        imageUrl: pathToFileURL(tmpPath).href,
        imgWidth: sz.width,
        imgHeight: sz.height
      });
    });
  });
});

ipcMain.handle('region-ocr-commit', async (_event, rect) => {
  const st = regionOcrState;
  if (!st || !st.fullImage) return { ok: false };

  const cropped = clampAndCropNativeImage(st.fullImage, rect);
  if (!cropped) {
    return { ok: false, errorKey: 'selection-too-small' };
  }

  const ocr = await extractTextFromNativeImage(cropped);
  const userResolve = regionOcrFlowResolve;
  regionOcrFlowResolve = null;
  regionOcrState = null;

  try {
    if (st.tmpPath && fs.existsSync(st.tmpPath)) fs.unlinkSync(st.tmpPath);
  } catch (_) {}

  if (userResolve) {
    userResolve({
      ok: ocr.ok && !!String(ocr.text || '').trim(),
      text: String(ocr.text || '').trim(),
      errorKey: !ocr.ok ? 'ocr-failed' : !String(ocr.text || '').trim() ? 'ocr-no-text' : undefined
    });
  }

  if (regionPickerWindow && !regionPickerWindow.isDestroyed()) {
    regionPickerWindow.close();
  }

  return { ok: true };
});

ipcMain.handle('region-ocr-abort', async () => {
  const st = regionOcrState;
  try {
    if (st && st.tmpPath && fs.existsSync(st.tmpPath)) fs.unlinkSync(st.tmpPath);
  } catch (_) {}

  const userResolve = regionOcrFlowResolve;
  regionOcrFlowResolve = null;
  regionOcrState = null;

  if (userResolve) {
    userResolve({ ok: false, errorKey: 'cancelled' });
  }

  if (regionPickerWindow && !regionPickerWindow.isDestroyed()) {
    regionPickerWindow.close();
  }

  return { ok: true };
});

// Start a persistent window monitor process (Windows) or poll frontmost app (macOS — reliable inside packaged .app).
let monitorProcess = null;
let macMonitorTimer = null;

function startWindowMonitor() {
  stopWindowMonitor();

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  if (isWin) {
    const scriptPath = pathToScript('window-monitor.ps1');
    const ourHandle = mainWindow ? mainWindow.getNativeWindowHandle().readInt32LE(0) : 0;
    monitorProcess = spawn('powershell', [
      '-NoProfile',
      '-NoLogo',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-ExcludeHandle',
      ourHandle.toString()
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });

    monitorProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const handleMatch = trimmed.match(/HANDLE:(\d+)/);
        const nameMatch = trimmed.match(/NAME:([^\s]+)/);
        if (handleMatch) lastExternalWindowHandle = handleMatch[1];
        if (nameMatch) lastExternalWindowName = nameMatch[1];
      }
    });

    monitorProcess.on('error', (err) => {
      console.error('Window monitor error:', err);
    });
  } else if (isMac) {
    macMonitorTimer = setInterval(() => {
      try {
        const r = spawnSync(
          'osascript',
          ['-e', 'tell application "System Events" to return name of first process whose frontmost is true'],
          { encoding: 'utf8', timeout: 2000 }
        );
        if (r.status !== 0) return;
        const name = (r.stdout || '').trim();
        if (name && !OUR_PROCESS_NAMES.has(name)) {
          lastExternalWindowHandle = name;
          lastExternalWindowName = name;
        }
      } catch (_) {
        /* ignore */
      }
    }, 400);
  }
}

function stopWindowMonitor() {
  if (monitorProcess) {
    monitorProcess.kill();
    monitorProcess = null;
  }
  if (macMonitorTimer !== null) {
    clearInterval(macMonitorTimer);
    macMonitorTimer = null;
  }
}

/** Chromium network stack (proxy / TLS like the main window). Node's global fetch() often fails where renderer works. */
function openAiRequest(url, init) {
  return net.fetch(url, init);
}

const VISION_IMAGE_MAX_EDGE = 2048;

function clipboardSnapshot() {
  return {
    text: clipboard.readText(),
    image: clipboard.readImage()
  };
}

function clipboardRestoreSnapshot(snap) {
  if (!snap) return;
  const img = snap.image;
  if (img && !img.isEmpty()) {
    clipboard.write({ text: snap.text || '', image: img });
  } else {
    clipboard.writeText(snap.text || '');
  }
}

/** OCR via gpt-4o-mini vision (main process). */
async function extractTextFromNativeImage(img) {
  const apiKey = store.get('openaiApiKey');
  if (!apiKey) {
    return { ok: false, error: 'no-api-key', text: '' };
  }
  if (!img || img.isEmpty()) {
    return { ok: false, error: 'no-image', text: '' };
  }
  let work = img;
  const { width, height } = work.getSize();
  if (width > VISION_IMAGE_MAX_EDGE || height > VISION_IMAGE_MAX_EDGE) {
    const s = VISION_IMAGE_MAX_EDGE / Math.max(width, height);
    work = work.resize({
      width: Math.max(1, Math.round(width * s)),
      height: Math.max(1, Math.round(height * s))
    });
  }
  const png = work.toPNG();
  if (!png || png.length === 0) {
    return { ok: false, error: 'bad-image', text: '' };
  }
  if (png.length > 12 * 1024 * 1024) {
    return { ok: false, error: 'Image too large for OCR.', text: '' };
  }
  const base64 = Buffer.from(png).toString('base64');
  try {
    const response = await openAiRequest('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Extract all readable text from this image. Keep line breaks where they appear in the image. Reply with ONLY the extracted text — no markdown, no quotes, no explanation. If there is no text at all, reply exactly with: (none)'
              },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${base64}` }
              }
            ]
          }
        ],
        max_tokens: 4096,
        temperature: 0.1
      })
    });
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      return {
        ok: false,
        error: errBody.error?.message || 'Vision request failed',
        text: ''
      };
    }
    const data = await response.json();
    let t = (data.choices?.[0]?.message?.content || '').trim();
    if (/^\(none\)$/i.test(t)) t = '';
    return { ok: true, text: t, error: '' };
  } catch (e) {
    return { ok: false, error: friendlyOpenAiNetworkError(e), text: '' };
  }
}

/**
 * After simulated Cmd+C / copy: prefer new plain text; else OCR if clipboard has an image.
 * @returns {{ text: string, source: 'text'|'image'|'none', errorKey?: string }}
 */
async function resolveClipboardAfterCopy(snapshot) {
  const origTrim = (snapshot.text || '').trim();
  const newTrim = clipboard.readText().trim();
  const newImg = clipboard.readImage();

  if (newTrim.length > 0 && newTrim !== origTrim) {
    return { text: newTrim, source: 'text' };
  }

  if (!newImg.isEmpty()) {
    if (!store.get('openaiApiKey')) {
      return { text: '', source: 'none', errorKey: 'no-api-key-image' };
    }
    const r = await extractTextFromNativeImage(newImg);
    if (r.ok && r.text && r.text.trim()) {
      return { text: r.text.trim(), source: 'image' };
    }
    return {
      text: '',
      source: 'none',
      errorKey: !r.ok ? 'ocr-failed' : 'ocr-no-text'
    };
  }

  if (newTrim.length > 0) {
    return { text: newTrim, source: 'text' };
  }

  return { text: '', source: 'none', errorKey: 'empty' };
}

/** User-visible copy when fetch() to OpenAI fails (Node often reports only "fetch failed"). */
function friendlyOpenAiNetworkError(err, fallback = 'Request failed.') {
  if (!err) return fallback;
  const msg = String(err.message || '');
  const c = err.cause;
  const causeMsg = c ? String(c.message || '') : '';
  const code = err.code || (c && c.code);
  const blob = `${msg} ${causeMsg} ${String(code || '')}`.toLowerCase();
  if (
    /fetch failed/.test(blob) ||
    /econnrefused|enotfound|etimedout|econnreset|getaddrinfo|certificate|cert_|ssl|tls|proxy/.test(blob) ||
    ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code)
  ) {
    return "Can't reach OpenAI. Check your internet, VPN or firewall, and that api.openai.com isn't blocked.";
  }
  return msg || fallback;
}

function clampAndCropNativeImage(nativeImg, rect) {
  if (!nativeImg || nativeImg.isEmpty()) return null;
  const { width: iw, height: ih } = nativeImg.getSize();
  const x0 = Math.min(rect.x, rect.x + rect.width);
  const y0 = Math.min(rect.y, rect.y + rect.height);
  const x1 = Math.max(rect.x, rect.x + rect.width);
  const y1 = Math.max(rect.y, rect.y + rect.height);
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  let w = Math.min(iw - x, Math.ceil(x1 - x0));
  let h = Math.min(ih - y, Math.ceil(y1 - y0));
  if (w < 12 || h < 12) return null;
  try {
    return nativeImg.crop({ x, y, width: w, height: h });
  } catch (e) {
    console.error('crop failed:', e);
    return null;
  }
}

function closeRegionPickerWindow() {
  if (regionPickerWindow && !regionPickerWindow.isDestroyed()) {
    regionPickerWindow.close();
  }
  regionPickerWindow = null;
}

async function quickGrammarScan(text) {
  const apiKey = store.get('openaiApiKey');
  if (!apiKey || !text || !String(text).trim()) {
    return { noApiKey: !apiKey, hasIssues: null, summary: '' };
  }
  const slice = text.length > 3500 ? `${text.slice(0, 3500)}…` : text;
  let response;
  try {
    response = await openAiRequest('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Reply with ONLY valid JSON: {"hasIssues":true/false,"summary":"max 12 words"}. hasIssues true only if clear spelling/grammar/wording problems exist.'
          },
          { role: 'user', content: slice }
        ],
        temperature: 0.2,
        max_tokens: 80
      })
    });
  } catch (e) {
    return {
      noApiKey: false,
      hasIssues: null,
      summary: '',
      scanError: friendlyOpenAiNetworkError(e, "Couldn't analyze text — try again.")
    };
  }
  try {
    if (!response.ok) return { noApiKey: false, hasIssues: null, summary: '' };
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { noApiKey: false, hasIssues: null, summary: '' };
    let raw = String(content).trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    const j = JSON.parse(raw);
    return {
      noApiKey: false,
      hasIssues: !!j.hasIssues,
      summary: String(j.summary || '').slice(0, 120)
    };
  } catch {
    return { noApiKey: false, hasIssues: null, summary: '' };
  }
}

async function captureSelectionTextForFloat() {
  markGrammarClipboardIgnore(3200);
  const isWin = process.platform === 'win32';
  const snapshot = clipboardSnapshot();
  const handle = lastExternalWindowHandle || (isWin ? '0' : '');
  if (!isWin && (!handle || handle === '')) {
    return { text: '', err: 'no-target' };
  }
  try {
    if (isWin) {
      const scriptPath = pathToScript('copy-selection.ps1');
      await new Promise((resolve) => {
        exec(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -TargetHandle "${handle}"`,
          { windowsHide: true },
          () => resolve()
        );
      });
      await new Promise((r) => setTimeout(r, 120));
    } else {
      const r = await macCopySelectionInline(handle);
      if (!r.ok) return { text: '', err: 'copy-failed' };
      await new Promise((r2) => setTimeout(r2, 220));
    }
    const resolved = await resolveClipboardAfterCopy(snapshot);
    clipboardRestoreSnapshot(snapshot);
    try {
      prevClipboardTick = (snapshot.text || '').trim();
    } catch (_) {}
    return {
      text: resolved.text || '',
      err: resolved.text && resolved.text.trim() ? undefined : resolved.errorKey || 'empty',
      errorKey: resolved.errorKey,
      source: resolved.source
    };
  } catch (e) {
    clipboardRestoreSnapshot(snapshot);
    try {
      prevClipboardTick = (snapshot.text || '').trim();
    } catch (_) {}
    return { text: '', err: String(e.message || e) };
  }
}

function applyGrammarFloatResizable() {
  if (!grammarFloatWindow || grammarFloatWindow.isDestroyed()) return;
  grammarFloatWindow.setResizable(store.get('grammarFloatResizable') !== false);
}

function grammarFloatBgOpacityOrDefault() {
  const o = store.get('bgOpacity');
  if (typeof o === 'number' && Number.isFinite(o)) return o;
  const p = parseFloat(o);
  return Number.isFinite(p) ? p : 1;
}

/** Keep float UI glass opacity in sync with main app Settings → Transparency. */
function broadcastGrammarFloatAppearance() {
  if (!grammarFloatWindow || grammarFloatWindow.isDestroyed()) return;
  grammarFloatWindow.webContents.send('grammar-float-appearance', {
    bgOpacity: grammarFloatBgOpacityOrDefault()
  });
}

function ensureGrammarFloatWindow() {
  if (grammarFloatWindow && !grammarFloatWindow.isDestroyed()) {
    return grammarFloatWindow;
  }
  const canResize = store.get('grammarFloatResizable') !== false;
  grammarFloatWindow = new BrowserWindow({
    width: 150,
    height: 80,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: canResize,
    movable: true,
    hasShadow: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'grammar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  
  if (process.platform === 'win32') {
    grammarFloatWindow.setAlwaysOnTop(true, 'screen-saver');
  }
  
  grammarFloatWindow.setMinimumSize(220, 64);
  grammarFloatWindow.setVisibleOnAllWorkspaces(true);
  grammarFloatWindow.loadFile('grammar-float.html');
  grammarFloatWindow.on('closed', () => {
    grammarFloatWindow = null;
  });
  return grammarFloatWindow;
}

function positionGrammarFloatNear(point, win = grammarFloatWindow) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;
  let px = Math.round(point.x - b.width / 2);
  let py = Math.round(point.y - b.height - 18);
  if (py < wa.y + 8) {
    py = Math.round(point.y + 20);
  }
  px = Math.max(wa.x + 6, Math.min(px, wa.x + wa.width - b.width - 6));
  py = Math.max(wa.y + 6, Math.min(py, wa.y + wa.height - b.height - 6));
  win.setPosition(px, py);
}

const GRAMMAR_LOADER_SIZE = 44;

const GRAMMAR_LOADER_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden;
display:flex;align-items:center;justify-content:center;-webkit-app-region:no-drag}
.sp{width:28px;height:28px;border-radius:50%;flex-shrink:0;
background:conic-gradient(from 0deg,#00d4ff,#22d3ee,#6366f1,#8b5cf6,#a78bfa,#00d4ff);
-webkit-mask:radial-gradient(circle closest-side,transparent 9px,#000 10px,#000 13px,transparent 14px);
mask:radial-gradient(circle closest-side,transparent 9px,#000 10px,#000 13px,transparent 14px);
animation:grspin 0.75s linear infinite}
@keyframes grspin{to{transform:rotate(360deg)}}
</style></head><body><div class="sp" aria-hidden="true"></div></body></html>`;

function hideGrammarLoader() {
  if (grammarLoaderWindow && !grammarLoaderWindow.isDestroyed()) {
    grammarLoaderWindow.hide();
  }
}

function showGrammarLoaderAt(screenPoint) {
  const display = screen.getDisplayNearestPoint(screenPoint);
  const wa = display.workArea;
  let x = Math.round(screenPoint.x - GRAMMAR_LOADER_SIZE / 2);
  let y = Math.round(screenPoint.y - GRAMMAR_LOADER_SIZE / 2);
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - GRAMMAR_LOADER_SIZE));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - GRAMMAR_LOADER_SIZE));

  if (!grammarLoaderWindow || grammarLoaderWindow.isDestroyed()) {
    grammarLoaderWindow = new BrowserWindow({
      width: GRAMMAR_LOADER_SIZE,
      height: GRAMMAR_LOADER_SIZE,
      x,
      y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      focusable: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    });
    grammarLoaderWindow.setIgnoreMouseEvents(true);
    const dataUrl =
      'data:text/html;charset=utf-8,' + encodeURIComponent(GRAMMAR_LOADER_HTML);
    grammarLoaderWindow.loadURL(dataUrl);
  } else {
    grammarLoaderWindow.setBounds({
      x,
      y,
      width: GRAMMAR_LOADER_SIZE,
      height: GRAMMAR_LOADER_SIZE
    });
  }

  const win = grammarLoaderWindow;
  const showLoader = () => {
    if (!win.isDestroyed()) {
      if (process.platform === 'win32') {
        win.setAlwaysOnTop(true, 'screen-saver');
      } else {
        win.setAlwaysOnTop(true, 'floating');
      }
      if (typeof win.showInactive === 'function') {
        win.showInactive();
      } else {
        win.show();
      }
    }
  };

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', showLoader);
  } else {
    showLoader();
  }
}

async function pushGrammarFloatPayload(text, point, { focusWindow }) {
  const t = String(text || '').trim();
  if (!t) return false;

  const scan = await quickGrammarScan(t);
  const win = ensureGrammarFloatWindow();
  lastGrammarFloatPayloadText = t;
  const payload = {
    text: t,
    hasIssues: scan.hasIssues,
    summary: scan.summary || '',
    noApiKey: !!scan.noApiKey,
    scanError: scan.scanError || '',
    bgOpacity: grammarFloatBgOpacityOrDefault(),
    uiSoundsEnabled: store.get('uiSoundsEnabled') !== false
  };
  const push = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('grammar-init', payload);
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', push);
  } else {
    push();
  }
  positionGrammarFloatNear(point, win);
  
  if (focusWindow) {
    win.show();
    win.focus();
  } else if (typeof win.showInactive === 'function') {
    win.showInactive();
  } else {
    win.show();
  }

  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    win.setAlwaysOnTop(true, 'floating');
  }
  return true;
}

function grammarClipboardFollowsCopyEnabled() {
  if (process.platform === 'darwin') return false;
  return store.get('autoGrammarClipboard') !== false;
}

function startGrammarClipboardWatcher() {
  // Completely disabled as requested: "Никакого, блядь, Ctrl-C"
}

async function openGrammarFloatFromShortcut() {
  snapshotFrontmostPasteTarget();
  const point = screen.getCursorScreenPoint();
  showGrammarLoaderAt(point);
  try {
    const { text, err, errorKey } = await captureSelectionTextForFloat();
    if (!text || !text.trim()) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        let message =
          err === 'no-target'
            ? 'Click the app that has your selection, then try the shortcut again.'
            : process.platform === 'darwin'
              ? 'Highlight text or an image in the other app, then press ⌘⇧E (or Ctrl⇧E).'
              : 'Highlight text or an image in the other app, then copy (Ctrl+C) or press Ctrl+Shift+E.';
        if (errorKey === 'no-api-key-image') {
          message = 'Add your OpenAI API key in Settings to extract text from images.';
        } else if (errorKey === 'ocr-no-text') {
          message = 'No readable text found in the image.';
        } else if (errorKey === 'ocr-failed') {
          message = 'Could not read text from the image. Try again or use sharper capture.';
        }
        mainWindow.webContents.send('app-toast', {
          message,
          type: 'warning'
        });
      }
      return;
    }
    await pushGrammarFloatPayload(text, point, { focusWindow: true });
  } finally {
    hideGrammarLoader();
  }
}

function classifyMacPasteError(stderr) {
  const s = (stderr || '').toLowerCase();
  if (
    s.includes('empty paste target') ||
    s.includes('missing paste target') ||
    s.includes('process not found')
  ) {
    return 'no-target';
  }
  if (
    s.includes('not authorized') ||
    s.includes('-1743') ||
    s.includes('erraeeventnotpermitted') ||
    s.includes('event not permitted')
  ) {
    return 'accessibility';
  }
  return 'unknown';
}

ipcMain.handle('open-accessibility-settings', async () => {
  if (process.platform === 'darwin') {
    const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
    spawn('open', [url], { detached: true, stdio: 'ignore' });
  }
  return true;
});

ipcMain.handle('type-text', async (event, text) => {
  if (!text || text.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }

  try {
    if (process.platform === 'darwin') {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        return {
          ok: false,
          reason: 'accessibility',
          stderr:
            'Accessibility is OFF for this app in System Settings (toggle must be blue/on). macOS blocks System Events until you enable it.'
        };
      }
    }

    markGrammarClipboardIgnore(5000);
    const previousClipboard = clipboard.readText();
    clipboard.writeText(text);

    const isWin = process.platform === 'win32';
    const handle = lastExternalWindowHandle || (isWin ? '0' : '');
    const winScriptPath = pathToScript('paste-helper.ps1');

    const scheduleClipboardRestore = () => {
      setTimeout(() => {
        clipboard.writeText(previousClipboard || '');
        try {
          prevClipboardTick = (clipboard.readText() || '').trim();
        } catch (_) {}
        markGrammarClipboardIgnore(600);
      }, 1200);
    };

    if (isWin) {
      return await new Promise((resolve) => {
        exec(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${winScriptPath}" -TargetHandle "${handle}"`,
          { windowsHide: true },
          (error, stdout, stderr) => {
            scheduleClipboardRestore();
            if (error) console.error('PowerShell paste error:', error, stderr);
            resolve({ ok: !error, reason: error ? 'unknown' : undefined, stderr: stderr || undefined });
          }
        );
      });
    }

    // macOS: inline AppleScript only (no .scpt path) so Dock / installed .app works without unpacking scripts.
    if (!handle || handle === '') {
      scheduleClipboardRestore();
      return { ok: false, reason: 'no-target', stderr: 'Empty paste target' };
    }

    await sleep(80);

    let pasteAllResult = await macPasteAllInline(handle);
    if (!pasteAllResult.ok) {
      console.error('macOS inline paste failed:', pasteAllResult.stderr, 'trying focus + nut-js');
    }

    if (!pasteAllResult.ok) {
      const focusResult = await macFocusInline(handle);
      if (!focusResult.ok) {
        scheduleClipboardRestore();
        console.error('macOS focus failed:', focusResult.stderr);
        const reason = classifyMacPasteError(focusResult.stderr || '');
        return {
          ok: false,
          reason,
          stderr: focusResult.stderr || undefined
        };
      }

      await sleep(650);

      let nutOk = false;
      try {
        await keyboard.pressKey(Key.LeftCmd, Key.V);
        await keyboard.releaseKey(Key.LeftCmd, Key.V);
        nutOk = true;
      } catch (err) {
        console.error('nut-js Cmd+V failed, trying AppleScript keystroke:', err);
      }

      if (!nutOk) {
        const pasteOk = await new Promise((resolve) => {
          exec(
            'osascript -e \'tell application "System Events" to keystroke "v" using command down\'',
            { windowsHide: true },
            (error, stdout, stderr) => {
              if (error) console.error('AppleScript Cmd+V fallback failed:', error, stderr);
              resolve(!error);
            }
          );
        });
        if (!pasteOk) {
          scheduleClipboardRestore();
          return {
            ok: false,
            reason: 'paste-failed',
            stderr:
              'All paste methods failed — enable Accessibility for VoxFab AI, click the target field first, then try again'
          };
        }
      }
    }

    scheduleClipboardRestore();
    return { ok: true };
  } catch (error) {
    console.error('Failed to type text:', error);
    return { ok: false, reason: 'unknown', stderr: error.message };
  }
});

const GRAMMAR_AI_PROMPTS = {
  fix: 'Fix any spelling, grammar, and punctuation errors in the following text. Preserve the original meaning and style exactly. Return ONLY the corrected text.',
  professional:
    'Rewrite the following text in a formal, professional business tone suitable for an email or report. Return ONLY the rewritten text.',
  summary:
    'Create a very concise summary of the following text using bullet points if appropriate. Return ONLY the summary.',
  reply:
    'Draft a helpful, polite, and concise reply to the following message. Adapt to the tone of the message. Return ONLY the reply text.',
  shorten:
    'Shorten the following text significantly while keeping the core message and all important facts. Return ONLY the shortened text.',
  rephrase:
    'Rephrase the following text to sound natural and clear while preserving the original meaning and tone. Return ONLY the rephrased text.',
  expand:
    'Expand the following text by adding more detail and professional polish while maintaining the original intent. Return ONLY the expanded text.'
};

/** Floating assistant: 3 blocks split by --- or by blank lines */
function parseThreeModelSegments(raw) {
  const text = String(raw || '').trim();
  let parts = text
    .split(/\r?\n\s*-{3,}\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 3) {
    parts = text
      .split(/\r?\n\r?\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }
  return parts.slice(0, 3);
}

ipcMain.handle('grammar-float-three-rephrases', async (_event, { text }) => {
  const apiKey = store.get('openaiApiKey');
  if (!apiKey) {
    return { ok: false, error: 'Set OpenAI API key in VoxFab AI settings.' };
  }
  const t = String(text || '').trim();
  if (!t) {
    return { ok: false, error: 'No text to transform.' };
  }

  const userContent =
    'Give exactly 3 different rephrasings of the text. Same meaning and tone, different wording.\n\n' +
    'Rules: output only the three texts. Between them put one line that contains only three dashes: ---\n' +
    'No numbers, no labels, no markdown.\n\n' +
    `Text:\n${t}`;

  try {
    const response = await openAiRequest('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a writing assistant. Follow the user format exactly. No preamble, no closing remarks.'
          },
          { role: 'user', content: userContent }
        ],
        temperature: 0.65
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const msg = errBody.error?.message || 'AI request failed';
      return { ok: false, error: msg };
    }

    const data = await response.json();
    const rawContent = data.choices[0].message.content.trim();
    const suggestions = parseThreeModelSegments(rawContent);
    if (suggestions.length < 3) {
      return { ok: false, error: 'Could not get 3 options. Try Rephrase again.' };
    }
    return { ok: true, suggestions };
  } catch (e) {
    console.error('grammar-float-three-rephrases:', e);
    return { ok: false, error: friendlyOpenAiNetworkError(e, e.message || 'AI failed') };
  }
});

ipcMain.handle('grammar-float-three-fix-polish', async (_event, { text }) => {
  const apiKey = store.get('openaiApiKey');
  if (!apiKey) {
    return { ok: false, error: 'Set OpenAI API key in VoxFab AI settings.' };
  }
  const t = String(text || '').trim();
  if (!t) {
    return { ok: false, error: 'No text to transform.' };
  }

  const userContent =
    'Give exactly 3 alternative corrected versions of the text. Fix spelling, grammar, and punctuation. ' +
    'Keep the same meaning and overall style; versions may differ slightly where several correct choices exist ' +
    '(e.g. comma style, light punctuation, optional words).\n\n' +
    'Rules: output only the three corrected texts. Between them put one line that contains only three dashes: ---\n' +
    'No numbers, no labels, no markdown.\n\n' +
    `Text:\n${t}`;

  try {
    const response = await openAiRequest('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a writing assistant. Follow the user format exactly. No preamble, no closing remarks.'
          },
          { role: 'user', content: userContent }
        ],
        temperature: 0.45
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const msg = errBody.error?.message || 'AI request failed';
      return { ok: false, error: msg };
    }

    const data = await response.json();
    const rawContent = data.choices[0].message.content.trim();
    const suggestions = parseThreeModelSegments(rawContent);
    if (suggestions.length < 3) {
      return { ok: false, error: 'Could not get 3 options. Try Fix & Polish again.' };
    }
    return { ok: true, suggestions };
  } catch (e) {
    console.error('grammar-float-three-fix-polish:', e);
    return { ok: false, error: friendlyOpenAiNetworkError(e, e.message || 'AI failed') };
  }
});

ipcMain.handle('grammar-ai-action', async (_event, { type, text, customInstruction }) => {
  const apiKey = store.get('openaiApiKey');
  if (!apiKey) {
    return { ok: false, error: 'Set OpenAI API key in VoxFab AI settings.' };
  }
  const t = String(text || '').trim();
  if (!t) {
    return { ok: false, error: 'No text to transform.' };
  }

  let userContent;
  if (type === 'custom') {
    const instr = String(customInstruction || '').trim();
    if (!instr) {
      return { ok: false, error: 'Enter an instruction first.' };
    }
    userContent = `${instr}\n\nText: "${t}"`;
  } else {
    const prompt = GRAMMAR_AI_PROMPTS[type];
    if (!prompt) {
      return { ok: false, error: 'Unknown action.' };
    }
    userContent = `${prompt}\n\nText: "${t}"`;
  }

  try {
    const response = await openAiRequest('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful writing assistant. Return ONLY the requested transformed text with no preamble or explanation.'
          },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const msg = errBody.error?.message || 'AI request failed';
      return { ok: false, error: msg };
    }

    const data = await response.json();
    const result = data.choices[0].message.content.trim().replace(/^"|"$/g, '');
    return { ok: true, result };
  } catch (e) {
    console.error('grammar-ai-action:', e);
    return { ok: false, error: friendlyOpenAiNetworkError(e, e.message || 'AI failed') };
  }
});

ipcMain.handle('open-writing-assistant', async () => {
  await openGrammarFloatFromShortcut();
  return true;
});

ipcMain.handle('grammar-float-close', () => {
  lastGrammarFloatPayloadText = '';
  if (grammarFloatWindow && !grammarFloatWindow.isDestroyed()) {
    grammarFloatWindow.hide();
  }
  return true;
});

ipcMain.on('grammar-float-resize', (_event, { width, height }) => {
  if (!grammarFloatWindow || grammarFloatWindow.isDestroyed()) return;
  const w = Math.max(56, Math.round(Number(width) || 56));
  const h = Math.max(56, Math.round(Number(height) || 56));
  grammarFloatWindow.setSize(w, h);
});

const MINI_FAB_SIZE = 90;
const MINI_FAB_WIDE_WIDTH = 210;

function getFabScaleOrDefault() {
  const s = parseFloat(store.get('fabScale'));
  return Number.isFinite(s) ? Math.max(0.6, Math.min(1.8, s)) : 1;
}

function broadcastCollapsedAppearance() {
  const payload = {
    bgOpacity: grammarFloatBgOpacityOrDefault(),
    fabScale: getFabScaleOrDefault()
  };
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    syncMiniFabWidth();
    miniFabWindow.webContents.send('collapsed-appearance', payload);
  }
  if (edgeTabWindow && !edgeTabWindow.isDestroyed()) {
    placeEdgeTab();
    edgeTabWindow.webContents.send('collapsed-appearance', payload);
  }
}

/** While recording, widen the FAB window (keeping the button in place) to make room for side waves. */
function syncMiniFabWidth() {
  if (!miniFabWindow || miniFabWindow.isDestroyed()) return;
  const scale = getFabScaleOrDefault();
  const wantW = Math.round((isRecording ? MINI_FAB_WIDE_WIDTH : MINI_FAB_SIZE) * scale);
  const wantH = Math.round(MINI_FAB_SIZE * scale);
  try {
    miniFabWindow.webContents.setZoomFactor(scale);
  } catch (_) {}
  const b = miniFabWindow.getBounds();
  if (b.width === wantW && b.height === wantH) return;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  miniFabWindow.setBounds({
    x: Math.round(cx - wantW / 2),
    y: Math.round(cy - wantH / 2),
    width: wantW,
    height: wantH
  });
}

ipcMain.on('audio-levels', (_event, levels) => {
  for (const win of [miniFabWindow, edgeTabWindow]) {
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.webContents.send('audio-levels', levels);
    }
  }
});

function ensureMiniFabWindow() {
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    return miniFabWindow;
  }
  miniFabWindow = new BrowserWindow({
    width: MINI_FAB_SIZE,
    height: MINI_FAB_SIZE,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.platform === 'win32') {
    miniFabWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  miniFabWindow.loadFile('mini-fab.html');
  miniFabWindow.webContents.on('did-finish-load', () => {
    if (!miniFabWindow || miniFabWindow.isDestroyed()) return;
    syncMiniFabWidth();
    miniFabWindow.webContents.send('collapsed-appearance', {
      bgOpacity: grammarFloatBgOpacityOrDefault(),
      fabScale: getFabScaleOrDefault()
    });
  });
  miniFabWindow.on('closed', () => {
    miniFabWindow = null;
  });
  return miniFabWindow;
}

// ============================================
// Docked edge tab (collapsed mode #3)
// ============================================
// Always glued to a screen edge (work area, so it sits beside the Dock / below the menu bar).
// Dragging slides it along the nearest edge; it can never float free.
const EDGE_TAB_THICKNESS = 30; // tab sizes below must match edge-tab.css
const EDGE_TAB_BASE_LENGTH = 56;
const EDGE_TAB_HOVER_EXTRA = 28; // expand button (20px) + gaps, outside the tab
const EDGE_TAB_OVERHANG = 14; // >= macOS window corner radius
// The window is a fixed transparent square that is only ever moved, never resized: resizing a
// transparent window on macOS intermittently leaves its empty area painted white. The tab and the
// expand button are sized by CSS inside it (edge-tab.css), and clicks pass through the empty part.
const EDGE_TAB_WAVE_EXTRA = 84; // room for side waves while recording
const EDGE_TAB_WINDOW_SIZE = EDGE_TAB_BASE_LENGTH + EDGE_TAB_WAVE_EXTRA + EDGE_TAB_HOVER_EXTRA;
const EDGE_TAB_EDGES = ['top', 'bottom', 'left', 'right'];

let edgeTabDragging = false;
/** { edge, point: {x, y} } — point is the tab's center along the edge, in screen coordinates. */
let edgeTabDock = null;

function hideCollapsedWindows() {
  if (miniFabWindow && !miniFabWindow.isDestroyed()) miniFabWindow.hide();
  if (edgeTabWindow && !edgeTabWindow.isDestroyed()) edgeTabWindow.hide();
}

function defaultEdgeTabDock() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { edge: 'bottom', point: { x: wa.x + wa.width / 2, y: wa.y + wa.height } };
}

function loadEdgeTabDock() {
  const saved = store.get('edgeTabDock');
  if (
    saved &&
    EDGE_TAB_EDGES.includes(saved.edge) &&
    saved.point &&
    Number.isFinite(saved.point.x) &&
    Number.isFinite(saved.point.y)
  ) {
    return saved;
  }
  return defaultEdgeTabDock();
}

/** Nearest work-area edge to a screen point. */
function nearestEdgeDock(point) {
  const wa = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea;
  const d = {
    left: Math.abs(point.x - wa.x),
    right: Math.abs(wa.x + wa.width - point.x),
    top: Math.abs(point.y - wa.y),
    bottom: Math.abs(wa.y + wa.height - point.y)
  };
  const edge = EDGE_TAB_EDGES.reduce((a, b) => (d[b] < d[a] ? b : a));
  return { edge, point: { x: point.x, y: point.y } };
}

function placeEdgeTab() {
  if (!edgeTabWindow || edgeTabWindow.isDestroyed()) return;
  if (!edgeTabDock) edgeTabDock = loadEdgeTabDock();
  const { edge, point } = edgeTabDock;
  const wa = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea;
  const scale = getFabScaleOrDefault();
  const S = Math.round(EDGE_TAB_WINDOW_SIZE * scale);
  const tabLen = Math.round((EDGE_TAB_BASE_LENGTH + (isRecording ? EDGE_TAB_WAVE_EXTRA : 0)) * scale);
  // Keep room for the hover expand button after the tab, so hovering never moves the window.
  const along = tabLen + Math.round(EDGE_TAB_HOVER_EXTRA * scale);
  const overhang = Math.round(EDGE_TAB_OVERHANG * scale);
  try {
    edgeTabWindow.webContents.setZoomFactor(scale);
  } catch (_) {}
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  // The tab sits at the start of the window (left / top) and reaches EDGE_TAB_OVERHANG past the
  // work-area edge (under the Dock / menu bar, or off-screen), so macOS's rounded window corners on
  // that side fall in transparent space and the tab's edge-side corners stay square.
  let x;
  let y;
  if (edge === 'top' || edge === 'bottom') {
    x = clamp(point.x - tabLen / 2, wa.x, wa.x + wa.width - along);
    y = edge === 'top' ? wa.y - overhang : wa.y + wa.height + overhang - S;
  } else {
    y = clamp(point.y - tabLen / 2, wa.y, wa.y + wa.height - along);
    x = edge === 'left' ? wa.x - overhang : wa.x + wa.width + overhang - S;
  }
  const b = edgeTabWindow.getBounds();
  if (b.x !== Math.round(x) || b.y !== Math.round(y) || b.width !== S || b.height !== S) {
    edgeTabWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: S, height: S });
  }
  edgeTabWindow.webContents.send('edge-tab-edge', edge);
}

function ensureEdgeTabWindow() {
  if (edgeTabWindow && !edgeTabWindow.isDestroyed()) return edgeTabWindow;
  edgeTabWindow = new BrowserWindow({
    width: EDGE_TAB_WINDOW_SIZE,
    height: EDGE_TAB_WINDOW_SIZE,
    show: false,
    frame: false,
    // Keep macOS default corner rounding: roundedCorners:false paints white squares in the
    // transparent corners. The edge-side corners are hidden in the overhang instead (placeEdgeTab).
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.platform === 'win32') {
    edgeTabWindow.setAlwaysOnTop(true, 'screen-saver');
  }
  // Click-through until the pointer is over the tab or its button (renderer reports it).
  edgeTabWindow.setIgnoreMouseEvents(true, { forward: true });
  edgeTabWindow.loadFile('edge-tab.html');
  edgeTabWindow.webContents.on('did-finish-load', () => {
    if (!edgeTabWindow || edgeTabWindow.isDestroyed()) return;
    placeEdgeTab();
    edgeTabWindow.webContents.send('toggle-recording', isRecording);
    edgeTabWindow.webContents.send('processing-state', isProcessing);
    edgeTabWindow.webContents.send('collapsed-appearance', {
      bgOpacity: grammarFloatBgOpacityOrDefault(),
      fabScale: getFabScaleOrDefault()
    });
  });
  edgeTabWindow.on('closed', () => {
    edgeTabWindow = null;
  });
  return edgeTabWindow;
}

ipcMain.handle('enter-edge-tab-mode', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (miniFabWindow && !miniFabWindow.isDestroyed()) miniFabWindow.hide();
  ensureEdgeTabWindow();
  edgeTabDragging = false;
  placeEdgeTab();
  edgeTabWindow.show();
  edgeTabWindow.webContents.send('toggle-recording', isRecording);
  edgeTabWindow.webContents.send('processing-state', isProcessing);
  edgeTabWindow.webContents.send('collapsed-appearance', {
    bgOpacity: grammarFloatBgOpacityOrDefault(),
    fabScale: getFabScaleOrDefault()
  });
  return true;
});

/** Renderer: pointer is over the tab / button (take clicks) or over the empty area (pass them through). */
ipcMain.on('edge-tab-interactive', (_event, interactive) => {
  if (!edgeTabWindow || edgeTabWindow.isDestroyed()) return;
  if (interactive) edgeTabWindow.setIgnoreMouseEvents(false);
  else if (!edgeTabDragging) edgeTabWindow.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on('edge-tab-drag', (_event, phase) => {
  if (!edgeTabWindow || edgeTabWindow.isDestroyed()) return;
  if (phase === 'start') {
    edgeTabDragging = true;
    return;
  }
  if (!edgeTabDragging) return;
  if (phase === 'cancel') {
    // Plain click: keep the dock where it was.
    edgeTabDragging = false;
    placeEdgeTab();
    return;
  }
  edgeTabDock = nearestEdgeDock(screen.getCursorScreenPoint());
  if (phase === 'end') {
    edgeTabDragging = false;
    store.set('edgeTabDock', edgeTabDock);
  }
  placeEdgeTab();
});

ipcMain.handle('toggle-recording-main', () => {
  toggleRecording();
  return isRecording;
});

ipcMain.handle('get-recording-state', () => {
  return isRecording;
});

ipcMain.on('grammar-float-set-resizable', (_event, { enabled }) => {
  if (!grammarFloatWindow || grammarFloatWindow.isDestroyed()) return;
  grammarFloatWindow.setResizable(!!enabled);
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('resize-window', (event, { width, height }) => {
  if (mainWindow) {
    mainWindow.setSize(width, height);
  }
});

// Handle language change
ipcMain.handle('close-window', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    app.quit();
  }
});

ipcMain.handle('set-recording-state', (event, s) => {
  const prevRecording = isRecording;
  if (process.platform === 'darwin' && s === true && !prevRecording) {
    snapshotFrontmostPasteTarget();
    macDuckPlaybackForRecordingStart();
  } else if (process.platform === 'darwin' && s === false && prevRecording) {
    macRestorePlaybackAfterRecordingStop();
  }
  isRecording = s;
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    syncMiniFabWidth();
    miniFabWindow.webContents.send('toggle-recording', isRecording);
  }
  if (edgeTabWindow && !edgeTabWindow.isDestroyed()) {
    placeEdgeTab();
    edgeTabWindow.webContents.send('toggle-recording', isRecording);
  }
});

ipcMain.handle('set-processing-state', (_event, s) => {
  isProcessing = !!s;
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    miniFabWindow.webContents.send('processing-state', isProcessing);
  }
  if (edgeTabWindow && !edgeTabWindow.isDestroyed()) {
    edgeTabWindow.webContents.send('processing-state', isProcessing);
  }
});

ipcMain.handle('get-processing-state', () => {
  return isProcessing;
});

ipcMain.handle('is-accessibility-trusted', () => {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
});

// ============================================
// GitHub Release Auto-Update Checker (Every 6 Hours)
// ============================================
const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/icelanderus/VoxFab-AI/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let latestUpdateInfo = {
  available: false,
  currentVersion: app.getVersion(),
  latestVersion: app.getVersion(),
  downloadUrl: '',
  assetName: '',
  htmlUrl: 'https://github.com/icelanderus/VoxFab-AI/releases/latest'
};
let updateCheckTimer = null;
let updateDownloading = false;

function parseSemverTuple(ver) {
  const clean = String(ver || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
  const parts = clean.split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewerSemver(candidate, current) {
  const [a0, a1, a2] = parseSemverTuple(candidate);
  const [b0, b1, b2] = parseSemverTuple(current);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

async function checkForGitHubUpdates() {
  try {
    const response = await net.fetch(GITHUB_LATEST_RELEASE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `VoxFab-AI/${app.getVersion()}`
      }
    });
    if (!response.ok) return latestUpdateInfo;
    const data = await response.json();
    const rawTag = String(data.tag_name || data.name || '').trim();
    const latestVersion = rawTag.replace(/^v/i, '');
    const currentVersion = app.getVersion();
    const available = !!latestVersion && isNewerSemver(latestVersion, currentVersion);

    const assets = Array.isArray(data.assets) ? data.assets : [];
    let pickedAsset = null;
    if (process.platform === 'win32') {
      pickedAsset =
        assets.find((a) => /Web-Setup.*\.exe$/i.test(a.name)) ||
        assets.find((a) => /\.exe$/i.test(a.name));
    } else if (process.platform === 'darwin') {
      const archPattern = process.arch === 'arm64' ? /arm64|apple-silicon/i : /x64|intel/i;
      pickedAsset =
        assets.find((a) => /\.dmg$/i.test(a.name) && archPattern.test(a.name)) ||
        assets.find((a) => /\.dmg$/i.test(a.name));
    }

    latestUpdateInfo = {
      available,
      currentVersion,
      latestVersion: latestVersion || currentVersion,
      downloadUrl: pickedAsset ? pickedAsset.browser_download_url : '',
      assetName: pickedAsset ? pickedAsset.name : '',
      htmlUrl: data.html_url || 'https://github.com/icelanderus/VoxFab-AI/releases/latest'
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', latestUpdateInfo);
    }
  } catch (err) {
    console.warn('Update check failed:', err && err.message);
  }
  return latestUpdateInfo;
}

function startUpdateCheckLoop() {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  setTimeout(() => {
    checkForGitHubUpdates().catch(() => {});
  }, 3500);
  updateCheckTimer = setInterval(() => {
    checkForGitHubUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
}

ipcMain.handle('check-for-updates', async () => {
  return await checkForGitHubUpdates();
});

ipcMain.handle('get-update-info', () => {
  return latestUpdateInfo;
});

ipcMain.handle('download-and-install-update', async () => {
  if (updateDownloading) return { ok: false, error: 'Download already in progress' };
  if (!latestUpdateInfo.available) {
    await checkForGitHubUpdates();
  }
  const url = latestUpdateInfo.downloadUrl;
  if (!url) {
    await shell.openExternal(latestUpdateInfo.htmlUrl || 'https://github.com/icelanderus/VoxFab-AI/releases/latest');
    return { ok: true, openedExternal: true };
  }

  updateDownloading = true;
  const sendProgress = (percent, status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', { percent, status });
    }
  };

  try {
    sendProgress(5, 'Downloading update…');
    const res = await net.fetch(url, {
      headers: { 'User-Agent': `VoxFab-AI/${app.getVersion()}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const safeName =
      latestUpdateInfo.assetName ||
      (process.platform === 'win32'
        ? `VoxFab-AI-Web-Setup-${latestUpdateInfo.latestVersion}.exe`
        : `VoxFab-AI-${latestUpdateInfo.latestVersion}.dmg`);
    const destPath = path.join(app.getPath('temp'), safeName);
    fs.writeFileSync(destPath, buf);
    sendProgress(100, 'Launching installer…');

    if (process.platform === 'win32') {
      const child = spawn(destPath, [], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.removeAllListeners('close');
        }
        app.quit();
      }, 450);
      return { ok: true };
    }

    await shell.openPath(destPath);
    return { ok: true };
  } catch (err) {
    console.error('Update download/install failed:', err);
    sendProgress(0, 'Update failed');
    return { ok: false, error: err.message || 'Could not download update' };
  } finally {
    updateDownloading = false;
  }
});

/** Installed .app is a different macOS identity than `npm run dev` (Electron / Terminal). Auto-paste needs Accessibility ON for VoxFab AI. */
function promptPackagedMacAccessibilityIfNeeded() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  if (systemPreferences.isTrustedAccessibilityClient(false)) return;

  setTimeout(() => {
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        title: 'VoxFab AI',
        message: 'Turn ON Accessibility for “VoxFab AI”',
        detail:
          'Auto-paste only works if this app is allowed in System Settings → Privacy & Security → Accessibility.\n\nThe row for “VoxFab AI” must show the switch ON (blue). Gray/left = still off.\n\nWhen you run “npm run dev”, macOS lists “Electron” or “Terminal” — that is a different entry than the installed app.',
        buttons: ['Open Accessibility settings', 'OK'],
        defaultId: 1,
        cancelId: 1
      })
      .then(({ response }) => {
        if (response === 0) {
          spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], {
            detached: true,
            stdio: 'ignore'
          });
        }
      });
  }, 1200);
}

// App lifecycle
app.whenReady().then(() => {
  try {
    prevClipboardTick = (clipboard.readText() || '').trim();
  } catch (_) {
    prevClipboardTick = '';
  }
  createWindow();
  createTray();
  registerGlobalShortcut();
  startWindowMonitor();
  startGrammarClipboardWatcher();
  startUpdateCheckLoop();
  promptPackagedMacAccessibilityIfNeeded();
});

app.on('will-quit', () => {
  macRestorePlaybackAfterRecordingStop();
  globalShortcut.unregisterAll();
  stopMacKeyWatcher();
  stopWindowMonitor();
  if (grammarLoaderWindow && !grammarLoaderWindow.isDestroyed()) {
    grammarLoaderWindow.destroy();
    grammarLoaderWindow = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
