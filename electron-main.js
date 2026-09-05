const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = 3050;
let currentDownloadDir = '';

// Determine default downloads directory
function getDefaultDownloadDir() {
  const userDownloads = app.getPath('downloads');
  const targetDir = path.join(userDownloads, 'JAV-Downloader');
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      return path.join(__dirname, 'temp_media');
    }
  }
  return targetDir;
}

// Check if a local server is already running on the given port
function checkServerHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json && json.status === 'ok');
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Start the embedded Express backend server
async function startBackendServer() {
  currentDownloadDir = getDefaultDownloadDir();

  // Test if server is already running
  const isRunning = await checkServerHealth(serverPort);
  if (isRunning) {
    console.log(`[Electron] Backend server already running on port ${serverPort}`);
    return;
  }

  console.log(`[Electron] Starting embedded backend on port ${serverPort} with downloads at: ${currentDownloadDir}`);

  const serverScript = path.join(__dirname, 'server.js');
  const env = {
    ...process.env,
    PORT: String(serverPort),
    TEMP_DIR: currentDownloadDir,
    NODE_ENV: 'production'
  };

  serverProcess = fork(serverScript, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout.on('data', (d) => {
    console.log(`[Server] ${d.toString().trim()}`);
  });

  serverProcess.stderr.on('data', (d) => {
    console.error(`[Server ERR] ${d.toString().trim()}`);
  });

  serverProcess.on('exit', (code, sig) => {
    console.log(`[Electron] Backend exited with code ${code}, signal ${sig}`);
    serverProcess = null;
  });

  // Poll until server is healthy
  const startTime = Date.now();
  while (Date.now() - startTime < 20000) {
    await new Promise(r => setTimeout(r, 400));
    const healthy = await checkServerHealth(serverPort);
    if (healthy) {
      console.log(`[Electron] Backend server confirmed healthy in ${Date.now() - startTime}ms`);
      return;
    }
  }
  console.warn('[Electron] Backend server health check timed out, proceeding anyway...');
}

function createMainWindow() {
  const icoPath = path.join(__dirname, 'public', 'favicon.ico');
  const iconPath = fs.existsSync(icoPath) ? icoPath : path.join(__dirname, 'public', 'icon.svg');

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 650,
    title: 'JAV & Universal Media Downloader',
    backgroundColor: '#0f172a',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    }
  });

  // Load the web application
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // Open external links in default system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (!url.includes(`127.0.0.1:${serverPort}`) && !url.includes(`localhost:${serverPort}`)) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  mainWindow.on('close', (e) => {
    // Graceful close
    mainWindow = null;
  });

  setupAppMenu();
}

function setupAppMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        {
          label: 'Open &Downloads Folder',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            if (currentDownloadDir && fs.existsSync(currentDownloadDir)) {
              shell.openPath(currentDownloadDir);
            }
          }
        },
        {
          label: 'Change &Downloads Location...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            if (mainWindow) {
              const res = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory', 'createDirectory'],
                title: 'Select New Downloads Destination',
                defaultPath: currentDownloadDir
              });
              if (!res.canceled && res.filePaths.length > 0) {
                currentDownloadDir = res.filePaths[0];
                try {
                  const req = http.request(`http://127.0.0.1:${serverPort}/api/config/download-dir`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                  });
                  req.write(JSON.stringify({ downloadDir: currentDownloadDir }));
                  req.end();
                } catch (e) {}
                if (Notification.isSupported()) {
                  new Notification({
                    title: 'Download Location Changed',
                    body: `Media will now save to:\n${currentDownloadDir}`
                  }).show();
                }
                mainWindow.webContents.send('download-dir-changed', currentDownloadDir);
              }
            }
          }
        },
        { type: 'separator' },
        {
          label: 'E&xit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload', label: '&Reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload', label: '&Force Reload', accelerator: 'CmdOrCtrl+Shift+R' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual &Size' },
        { role: 'zoomIn', label: 'Zoom &In', accelerator: 'CmdOrCtrl+Plus' },
        { role: 'zoomOut', label: 'Zoom &Out', accelerator: 'CmdOrCtrl+-' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle &Full Screen', accelerator: 'F11' }
      ]
    },
    {
      label: '&Tools',
      submenu: [
        {
          label: 'Toggle &Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools();
          }
        },
        {
          label: 'Open Web &Browser View',
          click: () => {
            shell.openExternal(`http://localhost:${serverPort}`);
          }
        }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: '&GitHub Repository',
          click: () => {
            shell.openExternal('https://github.com/PartnerKiller/JAV-Downloader');
          }
        },
        {
          label: '&About JAV-Downloader',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About JAV & Universal Media Downloader',
              message: 'JAV & Universal Media Downloader (Windows App)',
              detail: `Version: 1.0.0\nPlatform: Windows Desktop (x64)\nEngine: SpotiFLAC-Next + Multi-Platform HD Scrapers\nDownloads: ${currentDownloadDir}\n\nBuilt for high-performance offline and online media archiving.`,
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Setup IPC Handlers
function setupIpcHandlers() {
  ipcMain.handle('select-download-dir', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Downloads Folder',
      defaultPath: currentDownloadDir
    });
    if (!res.canceled && res.filePaths.length > 0) {
      currentDownloadDir = res.filePaths[0];
      try {
        const req = http.request(`http://127.0.0.1:${serverPort}/api/config/download-dir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        req.write(JSON.stringify({ downloadDir: currentDownloadDir }));
        req.end();
      } catch (e) {}
      return currentDownloadDir;
    }
    return null;
  });

  ipcMain.handle('get-download-dir', () => {
    return currentDownloadDir;
  });

  ipcMain.handle('select-flac-file', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select Audio / FLAC File for Authenticity Check',
      defaultPath: currentDownloadDir,
      filters: [
        { name: 'Audio Files', extensions: ['flac', 'wav', 'm4a', 'mp3', 'ogg', 'opus'] },
        { name: 'FLAC Audio', extensions: ['flac'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!res.canceled && res.filePaths.length > 0) {
      return res.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('open-folder', (event, targetPath) => {
    const target = targetPath || currentDownloadDir;
    if (target && fs.existsSync(target)) {
      if (fs.statSync(target).isDirectory()) {
        shell.openPath(target);
      } else {
        shell.showItemInFolder(target);
      }
    } else {
      shell.openPath(currentDownloadDir);
    }
    return true;
  });

  ipcMain.handle('open-external', (event, url) => {
    if (url) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('show-notification', (event, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({
        title: title || 'Download Ready',
        body: body || 'Your file has finished downloading.',
        icon: path.join(__dirname, 'public', 'icon.svg')
      }).show();
    }
    return true;
  });

  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
  });
}

// App Lifecycle
app.whenReady().then(async () => {
  setupIpcHandlers();
  await startBackendServer();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    console.log('[Electron] Shutting down embedded backend...');
    try {
      serverProcess.kill('SIGTERM');
    } catch (e) {}
    serverProcess = null;
  }
});
