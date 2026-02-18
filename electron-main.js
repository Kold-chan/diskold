/**
 * Diskold — Electron Wrapper (Desktop / .exe)
 * Creado por Kold
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Iniciar el servidor Node.js
require('./server.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 680,
    minHeight: 500,
    title: 'Diskold',
    backgroundColor: '#0a0a0c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    // Sin frame nativo en Windows, más limpio
    frame: true,
    show: false,
  });

  // Esperar un momento para que el servidor arranque
  setTimeout(() => {
    win.loadURL('http://localhost:3000');
    win.show();
  }, 1200);

  win.on('ready-to-show', () => {
    win.setTitle('Diskold — by Kold');
  });

  // Abrir links externos en el navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
