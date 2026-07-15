import { join } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';

import { CloseCoordinator } from './close-coordinator.js';
import { registerIpcHandlers } from './ipc.js';
import type { ApplicationServices } from './ipc.js';
import { verifyBundledGit } from './git-runtime.js';
import { LocalStore } from './storage.js';

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let services: ApplicationServices | null = null;
let closeCoordinator: CloseCoordinator | null = null;
let quitReady = false;
let quitAttempt: Promise<boolean> | null = null;
const approvedWindowCloses = new WeakSet<BrowserWindow>();

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
  .then(async () => {
    configureSessionSecurity();
    store = new LocalStore(join(app.getPath('userData'), 'forgeboard.sqlite'));
    if (process.argv.includes('--smoke-test')) {
      const gitVersion = await verifyBundledGit();
      process.stdout.write(`FORGEBOARD_SMOKE_OK ${gitVersion}\n`);
      store.close();
      store = null;
      app.quit();
      return;
    }
    services = registerIpcHandlers(store);
    closeCoordinator = new CloseCoordinator(dialog, ipcMain);
    mainWindow = createWindow(services, closeCoordinator);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && services && closeCoordinator) {
        mainWindow = createWindow(services, closeCoordinator);
      }
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

app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitAttempt !== null) return;
  const attempt = attemptApplicationQuit();
  quitAttempt = attempt;
  void attempt.then(
    (canQuit) => {
      if (!canQuit) {
        if (quitAttempt === attempt) quitAttempt = null;
        return;
      }
      quitReady = true;
      app.quit();
    },
    (error: unknown) => {
      process.stderr.write(
        `Forgeboard failed to stop cleanly: ${error instanceof Error ? error.message : 'unknown error'}\n`,
      );
      quitReady = true;
      app.exit(1);
    },
  );
});

async function attemptApplicationQuit(): Promise<boolean> {
  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    const coordinator = closeCoordinator;
    if (coordinator === null || !(await coordinator.requestSave(window))) return false;
  }
  await disposeApplication();
  return true;
}

async function disposeApplication(): Promise<void> {
  const applicationServices = services;
  services = null;
  if (applicationServices) await applicationServices.dispose();
  closeCoordinator?.dispose();
  closeCoordinator = null;
  store?.close();
  store = null;
}

function createWindow(
  applicationServices: ApplicationServices,
  coordinator: CloseCoordinator,
): BrowserWindow {
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

  window.on('close', (event) => {
    if (quitReady || approvedWindowCloses.has(window)) return;
    event.preventDefault();
    void coordinator.requestSave(window).then((canClose) => {
      if (!canClose || window.isDestroyed()) return;
      approvedWindowCloses.add(window);
      window.close();
    });
  });
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  // This handler also receives requests from untrusted preview subframes. Never let page content
  // turn window.open into an external-send primitive; a future explicit UI action must use a
  // separate validated IPC approval flow.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !applicationServices.previews.isAllowedFrameNavigation(event.url)) {
      event.preventDefault();
    }
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
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => callback({ cancel: !isLoopbackNetworkUrl(details.url) }),
  );
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

export function isLoopbackNetworkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
      return true;
    }
    const octets = hostname.split('.').map(Number);
    return (
      octets.length === 4 &&
      octets[0] === 127 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    );
  } catch {
    return false;
  }
}
