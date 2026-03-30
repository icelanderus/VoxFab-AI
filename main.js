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
  systemPreferences,
  dialog,
  net,
  shell
} = require('electron');
const { keyboard, Key, sleep } = require('@nut-tree-fork/nut-js');
const path = require('path');
const fs = require('fs');

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
        const raw = fs.readFileSync(this.configPath, 'utf-8');
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

const store = new ConfigStore({
  engine: 'local-whisper',
  openaiApiKey: '',
  googleApiKey: '',
  autoType: true,
  autoDetectLanguage: true,
  translateToEnglish: false,
  windowPosition: null,
  windowSize: { width: 340, height: 580 },
  bgOpacity: 0.85,
  bgBlur: 12,
  language: 'en',
  /** Win/Linux: open assistant when clipboard changes after copy. Default: false (user wants only explicit hotkeys). */
  autoGrammarClipboard: false,
  /** Allow dragging edges to resize the floating assistant window. */
  grammarFloatResizable: true,
  /** While recording, show interim text (Web Speech + periodic engine transcribe). Off by default (saves CPU/API). */
  livePreviewEnabled: false
});

let mainWindow = null;
let grammarFloatWindow = null;
let aboutWindow = null;
/** Tiny always-on-top spinner near cursor while assistant payload loads (API scan). */
let grammarLoaderWindow = null;
let tray = null;
let isRecording = false;
let miniFabWindow = null;

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
  app.setAppUserModelId('com.icelanderus.my-voice-to-text');
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const savedPosition = store.get('windowPosition');
  const savedSize = store.get('windowSize') || { width: 340, height: 580 };
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
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
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
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
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

  tray.setToolTip('VibeType AI');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
      mainWindow.focus();
    }
  });
}

function toggleRecording() {
  isRecording = !isRecording;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('toggle-recording', isRecording);
  }
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    miniFabWindow.webContents.send('toggle-recording', isRecording);
  }
}

function registerGlobalShortcut() {
  const isMac = process.platform === 'darwin';

  const onToggleHotkey = () => {
    snapshotFrontmostPasteTarget();
    toggleRecording();
    if (mainWindow && !mainWindow.isVisible()) {
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

  if (isMac) {
    if (!globalShortcut.register('Command+Shift+Space', onToggleHotkey)) {
      console.error('Failed to register Command+Shift+Space');
    }
    if (!globalShortcut.register('Ctrl+Shift+Space', onToggleHotkey)) {
      console.error('Failed to register Ctrl+Shift+Space on macOS');
    }
    if (!globalShortcut.register('Command+Alt+A', onAnalyzeHotkey)) {
      console.error('Failed to register Command+Alt+A');
    }
    if (!globalShortcut.register('Ctrl+Alt+A', onAnalyzeHotkey)) {
      console.error('Failed to register Ctrl+Alt+A on macOS');
    }
    if (!globalShortcut.register('Command+Shift+E', onGrammarHotkey)) {
      console.error('Failed to register Command+Shift+E');
    }
    if (!globalShortcut.register('Ctrl+Shift+E', onGrammarHotkey)) {
      console.error('Failed to register Ctrl+Shift+E (grammar) on macOS');
    }
  } else {
    if (!globalShortcut.register('Ctrl+Shift+Space', onToggleHotkey)) {
      console.error('Failed to register Ctrl+Shift+Space');
    }
    if (!globalShortcut.register('Ctrl+Alt+A', onAnalyzeHotkey)) {
      console.error('Failed to register Ctrl+Alt+A');
    }
    if (!globalShortcut.register('Ctrl+Shift+E', onGrammarHotkey)) {
      console.error('Failed to register Ctrl+Shift+E (grammar)');
    }
  }
}

// IPC Handlers
ipcMain.handle('get-settings', () => {
  return {
    engine: store.get('engine'),
    openaiApiKey: store.get('openaiApiKey'),
    googleApiKey: store.get('googleApiKey'),
    autoType: store.get('autoType'),
    autoDetectLanguage: store.get('autoDetectLanguage'),
    translateToEnglish: store.get('translateToEnglish'),
    language: store.get('language'),
    bgOpacity: store.get('bgOpacity'),
    bgBlur: store.get('bgBlur'),
    assistantEnabled: store.get('assistantEnabled') !== false,
    grammarFloatResizable: store.get('grammarFloatResizable') !== false,
    livePreviewEnabled: store.get('livePreviewEnabled') === true
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
  }
  if (settings.bgBlur !== undefined) store.set('bgBlur', settings.bgBlur);
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
  return true;
});

ipcMain.handle('enter-mini-mode', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  ensureMiniFabWindow();
  if (miniFabWindow) {
    miniFabWindow.show();
    // Immediate sync of recording state to the FAB
    miniFabWindow.webContents.send('toggle-recording', isRecording);
  }
  return true;
});

ipcMain.handle('exit-mini-mode', () => {
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    miniFabWindow.hide();
  }
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
  dragOffset = offset;
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

const OUR_PROCESS_NAMES = new Set(['Electron', 'VibeType AI']);

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

ipcMain.handle('capture-selection', async () => {
  markGrammarClipboardIgnore(3200);
  const isMac = process.platform === 'darwin';
  const originalText = clipboard.readText();
  
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
       // Mac implementation (simplified for now)
       exec(`osascript -e 'tell application "${handle}" to activate' -e 'tell application "System Events" to keystroke "c" using command down'`);
       await new Promise(r => setTimeout(r, 400));
    }
    
    const capturedText = clipboard.readText();
    
    // Restore original clipboard
    clipboard.writeText(originalText);
    try {
      prevClipboardTick = (originalText || '').trim();
    } catch (_) {}
    
    return {
      text: capturedText,
      windowContext: lastExternalWindowName || lastExternalWindowHandle
    };
  } catch (error) {
    console.error('Capture selection failed:', error);
    clipboard.writeText(originalText);
    try {
      prevClipboardTick = (originalText || '').trim();
    } catch (_) {}
    return null;
  }
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
  const originalText = clipboard.readText();
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
    const captured = clipboard.readText();
    clipboard.writeText(originalText);
    try {
      prevClipboardTick = (originalText || '').trim();
    } catch (_) {}
    return { text: captured || '' };
  } catch (e) {
    clipboard.writeText(originalText);
    try {
      prevClipboardTick = (originalText || '').trim();
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
  return Number.isFinite(p) ? p : 0.85;
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
    bgOpacity: grammarFloatBgOpacityOrDefault()
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
    const { text, err } = await captureSelectionTextForFloat();
    if (!text || !text.trim()) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-toast', {
          message:
            err === 'no-target'
              ? 'Click the app that has your selection, then try the shortcut again.'
              : process.platform === 'darwin'
                ? 'Highlight text in the other app, then press ⌘⇧E (or Ctrl⇧E).'
                : 'Highlight text in the other app, then copy (Ctrl+C) or press Ctrl+Shift+E.',
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
    markGrammarClipboardIgnore(5000);
    const previousClipboard = clipboard.readText();
    clipboard.writeText(text);

    const isWin = process.platform === 'win32';
    if (!isWin) {
      snapshotFrontmostPasteTarget();
    }
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
              'All paste methods failed — enable Accessibility for VibeType AI, click the target field first, then try again'
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
  expand:
    'Expand the following text by adding more detail and professional polish while maintaining the original intent. Return ONLY the expanded text.'
};

ipcMain.handle('grammar-ai-action', async (_event, { type, text, customInstruction }) => {
  const apiKey = store.get('openaiApiKey');
  if (!apiKey) {
    return { ok: false, error: 'Set OpenAI API key in VibeType AI settings.' };
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

function ensureMiniFabWindow() {
  if (miniFabWindow && !miniFabWindow.isDestroyed()) {
    return miniFabWindow;
  }
  miniFabWindow = new BrowserWindow({
    width: 90,
    height: 90,
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
  miniFabWindow.on('closed', () => {
    miniFabWindow = null;
  });
  return miniFabWindow;
}

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
  isRecording = s;
});

ipcMain.handle('is-accessibility-trusted', () => {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
});

/** Installed .app is a different macOS identity than `npm run dev` (Electron / Terminal). Auto-paste needs Accessibility ON for VibeType AI. */
function promptPackagedMacAccessibilityIfNeeded() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  if (systemPreferences.isTrustedAccessibilityClient(false)) return;

  setTimeout(() => {
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        title: 'VibeType AI',
        message: 'Turn ON Accessibility for “VibeType AI”',
        detail:
          'Auto-paste only works if this app is allowed in System Settings → Privacy & Security → Accessibility.\n\nWhen you run “npm run dev”, macOS lists “Electron” or “Terminal” — that is a different entry. The installed app needs its own toggle ON (blue).',
        buttons: ['Open Accessibility settings', 'OK'],
        defaultId: 0,
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
  promptPackagedMacAccessibilityIfNeeded();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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
