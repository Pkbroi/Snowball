const { app, BrowserWindow, powerSaveBlocker } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;

if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'trading-journal-dev-v2'));
}

// ── Windows GPU & rendering flags (safe subset) ────────────────────────────
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    icon: path.join(__dirname, 'dist', 'icon.png'),
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
    autoHideMenuBar: true,
  });

  // Prevent display sleep while journal is open
  const blocker = powerSaveBlocker.start('prevent-display-sleep');
  mainWindow.on('closed', () => {
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
