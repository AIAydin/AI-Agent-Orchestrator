import { join } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { app, BrowserWindow, session, shell } from 'electron';

import { registerIpcHandlers } from './ipc.js';
import type { RunService } from './run-service.js';
import { LocalStore } from './storage.js';

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let runService: RunService | null = null;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.setName(PRODUCT.name);

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

void app
  .whenReady()
  .then(() => {
    configureSessionSecurity();
    store = new LocalStore(join(app.getPath('userData'), 'forgeboard.sqlite'));
    if (process.argv.includes('--smoke-test')) {
      process.stdout.write('FORGEBOARD_SMOKE_OK\n');
      store.close();
      store = null;
      app.quit();
      return;
    }
    runService = registerIpcHandlers(store);
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Forgeboard failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  runService?.dispose();
  runService = null;
  store?.close();
  store = null;
});

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: PRODUCT.name,
    width: 1500,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#111416',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

function configureSessionSecurity(): void {
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const development = Boolean(process.env.ELECTRON_RENDERER_URL);
    const scriptPolicy = development ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'";
    const connectPolicy = development
      ? "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*"
      : "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            scriptPolicy,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            connectPolicy,
            'frame-src http://127.0.0.1:* http://localhost:*',
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
          ].join('; '),
        ],
      },
    });
  });
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
