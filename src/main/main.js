require('dotenv').config();
const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
    app.quit();
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    
    // Open DevTools for debugging
    mainWindow.webContents.openDevTools();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('second-instance', () => {
    if (!mainWindow) {
        createWindow();
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.focus();
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    app.quit();
});

app.on('before-quit', () => {
    BrowserWindow.getAllWindows().forEach((window) => {
        window.removeAllListeners('close');
        window.removeAllListeners('closed');
    });
});

// IPC Handler to provide API keys to the renderer securely
ipcMain.handle('get-env', () => {
    return {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY
    };
});

// IPC Handler to get desktop screen sources for the renderer
ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    return sources.map(source => ({
        id: source.id,
        name: source.name
    }));
});
