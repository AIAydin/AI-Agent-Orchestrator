import { join } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';

import { PACKAGED_SMOKE_MARKER } from '../shared/smoke/contracts.js';
import { CloseCoordinator } from './lifecycle/close-coordinator.js';
import { registerIpcHandlers } from './ipc.js';
import type { ApplicationServices } from './ipc.js';
import { verifyBundledGit } from './git/git-runtime.js';
import { configurePackagedSmokeProfile, runPackagedApplicationSmoke } from './smoke/packaged.js';
import { LocalStore } from './storage.js';

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let services: ApplicationServices | null = null;
let closeCoordinator: CloseCoordinator | null = null;
let quitReady = false;
let quitAttempt: Promise<boolean> | null = null;
const approvedWindowCloses = new WeakSet<BrowserWindow>();
app.setName(PRODUCT.name);
const packagedSmokeProfile = configurePackagedSmokeProfile(app, process.argv);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

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
    services = registerIpcHandlers(store);
    closeCoordinator = new CloseCoordinator(dialog, ipcMain);
    mainWindow = createWindow(services, closeCoordinator, packagedSmokeProfile === null);

    if (packagedSmokeProfile !== null) {
      const report = await runPackagedApplicationSmoke({
        profile: packagedSmokeProfile,
        webContents: mainWindow.webContents,
        runs: services.runs,
        store,
        agentExecutablePath: process.execPath,
        testAgentResourcePath: join(process.resourcesPath, 'test-agent', 'cli.js'),
        verifyGit: verifyBundledGit,
      });
      quitReady = true;
      mainWindow.destroy();
      await disposeApplication();
      process.stdout.write(`${PACKAGED_SMOKE_MARKER} ${JSON.stringify(report)}\n`);
      app.quit();
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && services && closeCoordinator) {
        mainWindow = createWindow(services, closeCoordinator);
      }
    });
  })
  .catch(async (error: unknown) => {
    process.stderr.write(
      `Forgeboard failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    if (packagedSmokeProfile !== null) {
      quitReady = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      try {
        await disposeApplication();
      } catch (cleanupError) {
        process.stderr.write(
          `Forgeboard smoke cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown error'}\n`,
        );
      }
      app.exit(1);
      return;
    }
    app.quit();
  });

app.on('window-all-closed', () => {
  if (packagedSmokeProfile !== null) return;
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
  try {
    await services?.prepareToQuit();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The configured backup could not run.';
    const options = {
      type: 'warning' as const,
      title: 'Backup failed before quit',
      message: 'Forgeboard could not create the configured quit backup.',
      detail: `${detail}\n\nYour canvas save completed, but no fresh database backup was verified.`,
      buttons: ['Cancel quit', 'Quit without a fresh backup'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const decision =
      window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
    if (decision.response !== 1) return false;
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
  showWhenReady = true,
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
    if (process.platform !== 'darwin') {
      app.quit();
      return;
    }
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
  if (showWhenReady) window.once('ready-to-show', () => window.show());

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
