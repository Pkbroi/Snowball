const { app, BrowserWindow, dialog, powerSaveBlocker } = require('electron');
const fs = require('fs');
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
    // NEVER show a bare black window again: the v2 exe shipped without
    // dist/ (the build output had been deleted before electron-builder
    // ran, and electron-builder does not run the Vite build itself), so
    // loadFile silently failed and the app sat on a black screen with no
    // error anywhere. If the renderer is missing, say so plainly.
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    if (!fs.existsSync(indexPath)) {
      const msg = `Snowball could not start: the app files are missing from this install (dist/index.html not found at ${indexPath}). Please reinstall the app.`;
      console.error(msg);
      dialog.showErrorBox('Snowball failed to start', msg);
      mainWindow.loadURL(`data:text/html,<body style="background:#000;color:#fff;font-family:sans-serif;padding:40px"><h1>Snowball failed to start</h1><p>The app files are missing from this install (dist/index.html not found). Please reinstall the app.</p></body>`);
      return;
    }
    mainWindow.loadFile(indexPath);
    // Same safety net for any later load failure (corrupt install, etc.)
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error(`Failed to load app (${code}): ${desc}`);
      dialog.showErrorBox('Snowball failed to start', `The app could not load its files (${desc}). Please reinstall the app.`);
    });
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
