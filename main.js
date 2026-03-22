const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, clipboard } = require('electron');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
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
  bgOpacity: 0.85,
  bgBlur: 12,
  language: 'en'
});

let mainWindow = null;
let tray = null;
let isRecording = false;

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const savedPosition = store.get('windowPosition');
  const winWidth = 340;
  const winHeight = 480;

  const isWin = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: savedPosition ? savedPosition.x : screenWidth - winWidth - 20,
    y: savedPosition ? savedPosition.y : screenHeight - winHeight - 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
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

  mainWindow.loadFile('index.html');
  mainWindow.setVisibleOnAllWorkspaces(true);

  // Save window position on move
  mainWindow.on('moved', () => {
    const [x, y] = mainWindow.getPosition();
    store.set('windowPosition', { x, y });
  });

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

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

  tray.setToolTip('Voice To Text');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function toggleRecording() {
  isRecording = !isRecording;
  if (mainWindow) {
    mainWindow.webContents.send('toggle-recording', isRecording);
  }
}

function registerGlobalShortcut() {
  const isMac = process.platform === 'darwin';
  globalShortcut.register(isMac ? 'Command+Shift+Space' : 'Ctrl+Shift+Space', () => {
    toggleRecording();
    // Bring window to front if hidden
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  // Global hotkey for Selection Analysis
  globalShortcut.register(isMac ? 'Command+Alt+A' : 'Ctrl+Alt+A', () => {
    if (mainWindow) {
      mainWindow.webContents.send('trigger-analyze');
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
    }
  });
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
    bgBlur: store.get('bgBlur')
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
  if (settings.bgOpacity !== undefined) store.set('bgOpacity', settings.bgOpacity);
  if (settings.bgBlur !== undefined) store.set('bgBlur', settings.bgBlur);
  return true;
});

// Track the last externally focused window
let lastExternalWindowHandle = null;
let lastExternalWindowName = null;
const { spawn, exec } = require('child_process');

ipcMain.handle('capture-selection', async () => {
  const isMac = process.platform === 'darwin';
  const originalText = clipboard.readText();
  
  try {
    const isWin = process.platform === 'win32';
    const handle = lastExternalWindowHandle || (isWin ? '0' : '');
    const scriptPath = isWin 
      ? path.join(__dirname, 'scripts', 'copy-selection.ps1')
      : path.join(__dirname, 'scripts', 'macos-copy.scpt'); // Placeholder for now

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
    
    return {
      text: capturedText,
      windowContext: lastExternalWindowName || lastExternalWindowHandle
    };
  } catch (error) {
    console.error('Capture selection failed:', error);
    clipboard.writeText(originalText);
    return null;
  }
});

// Start a persistent window monitor process
let monitorProcess = null;

function startWindowMonitor() {
  const isWin = process.platform === 'win32';
  const scriptPath = isWin 
    ? path.join(__dirname, 'scripts', 'window-monitor.ps1')
    : path.join(__dirname, 'scripts', 'macos-monitor.scpt');

  const ourHandle = mainWindow ? mainWindow.getNativeWindowHandle().readInt32LE(0) : 0;

  if (isWin) {
    monitorProcess = spawn('powershell', [
      '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-ExcludeHandle', ourHandle.toString()
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
  } else {
    // macOS AppleScript monitor (gets frontmost app bundle ID)
    monitorProcess = spawn('osascript', [scriptPath], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
  }

  monitorProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (isWin) {
        // Parse "HANDLE:123 NAME:Slack"
        const handleMatch = trimmed.match(/HANDLE:(\d+)/);
        const nameMatch = trimmed.match(/NAME:([^\s]+)/);
        if (handleMatch) lastExternalWindowHandle = handleMatch[1];
        if (nameMatch) lastExternalWindowName = nameMatch[1];
      } else if (trimmed && !trimmed.startsWith('Voice To Text')) {
        lastExternalWindowHandle = trimmed;
        lastExternalWindowName = trimmed;
      }
    }
  });

  monitorProcess.on('error', (err) => {
    console.error('Window monitor error:', err);
  });
}

function stopWindowMonitor() {
  if (monitorProcess) {
    monitorProcess.kill();
    monitorProcess = null;
  }
}

ipcMain.handle('type-text', async (event, text) => {
  if (!text || text.trim().length === 0) return false;

  try {
    const previousClipboard = clipboard.readText();
    clipboard.writeText(text);

    const isWin = process.platform === 'win32';
    const handle = lastExternalWindowHandle || (isWin ? '0' : '');
    const scriptPath = isWin 
      ? path.join(__dirname, 'scripts', 'paste-helper.ps1')
      : path.join(__dirname, 'scripts', 'macos-paste.scpt');

    return new Promise((resolve) => {
      const cmd = isWin 
        ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -TargetHandle "${handle}"`
        : `osascript "${scriptPath}" "${handle}"`;

      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          console.error(`${isWin ? 'PowerShell' : 'AppleScript'} Error:`, error);
        }
        
        // Restore previous clipboard after a short delay
        setTimeout(() => {
          clipboard.writeText(previousClipboard || '');
        }, 800);
        resolve(!error);
      });
    });
  } catch (error) {
    console.error('Failed to type text:', error);
    return false;
  }
});



ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.handle('close-window', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    app.quit();
  }
});

ipcMain.handle('set-recording-state', (event, s) => {
  isRecording = s;
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
  registerGlobalShortcut();
  startWindowMonitor();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopWindowMonitor();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
