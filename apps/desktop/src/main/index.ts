import { join } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';

import { PACKAGED_SMOKE_MARKER } from '../shared/smoke/contracts.js';
import { PROJECT_VIDEO_SCHEME } from '../shared/files/videos/contracts.js';
import { attemptContextSnapshotStorageStartup } from './agent-execution/context/snapshot-store/startup.js';
import { videoPlaybackResponse } from './file-domain/videos/playback-response.js';
import { CloseCoordinator } from './lifecycle/close-coordinator.js';
import { createDefaultSettings, registerIpcHandlers } from './ipc.js';
import type { ApplicationServices } from './ipc.js';
import { verifyBundledGit } from './git/git-runtime.js';
import {
  hardenAttachingWebviewPreferences,
  installPreviewWebviewSecurity,
  shouldAttachPreviewWebview,
} from './previews/webview/webview-security.js';
import { PreviewAgentBrowser } from './previews/webview/preview-agent-browser.js';
import { openLocalStoreWithStartupDatabaseRecovery } from './recovery/database/startup-adapter/open-store.js';
import { configurePackagedSmokeProfile, runPackagedApplicationSmoke } from './smoke/packaged.js';
import { createNonInteractiveSmokeStartupDialog } from './smoke/startup-recovery-dialog.js';
import type { LocalStore } from './storage.js';
import { allowsForgeboardMicrophone } from './security/microphone-permission.js';

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let services: ApplicationServices | null = null;
let closeCoordinator: CloseCoordinator | null = null;
let quitReady = false;
let quitAttempt: Promise<boolean> | null = null;
const approvedWindowCloses = new WeakSet<BrowserWindow>();
protocol.registerSchemesAsPrivileged([
  {
    scheme: PROJECT_VIDEO_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
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
    // A losing second process must never inspect the winning process's live snapshot lease.
    if (!hasSingleInstanceLock) return;
    configureSessionSecurity();
    const contextSnapshotStorage = await attemptContextSnapshotStorageStartup(
      process.platform === 'win32' ? app.getPath('userData') : undefined,
    );
    if (!contextSnapshotStorage.ready) {
      process.stderr.write(
        `Forgeboard context startup deferred: ${contextSnapshotStorage.reason}\n`,
      );
    }
    const userDataPath = app.getPath('userData');
    const databasePath = join(userDataPath, 'forgeboard.sqlite');
    store = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog: packagedSmokeProfile === null ? dialog : createNonInteractiveSmokeStartupDialog(),
      userDataPath,
    });
    if (store === null) {
      // Recovery cancellation is a safe startup quit, before IPC registration or window creation.
      quitReady = true;
      app.quit();
      return;
    }
    const previewAgentBrowser = new PreviewAgentBrowser();
    services = registerIpcHandlers(store, previewAgentBrowser);
    session.defaultSession.protocol.handle(PROJECT_VIDEO_SCHEME, async (request) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405 });
      }
      try {
        const fileUrl = await services?.files.videoFileUrlForRequest(request.url);
        if (fileUrl === null || fileUrl === undefined) return new Response(null, { status: 404 });
        // The media element sends Range requests; answer them directly so
        // MP4s with a trailing index load and seeking works.
        return await videoPlaybackResponse(fileUrl, {
          method: request.method,
          rangeHeader: request.headers.get('range'),
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    installPreviewWebviewSecurity(app, {
      confirmOpenExternal: async (url) => {
        const parent = mainWindow;
        if (!parent || parent.isDestroyed()) return false;
        const decision = await dialog.showMessageBox(parent, {
          type: 'warning',
          title: 'Open link in your browser?',
          message: 'The preview wants to open a page outside Forgeboard.',
          detail: url,
          buttons: ['Cancel', 'Open in browser'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return decision.response === 1;
      },
      openExternal: async (url) => {
        await shell.openExternal(url, { activate: true });
      },
      // Internet pages are handled by BrowserCompanionService in real Chrome.
      // Electron guest sessions remain loopback-only, even if the renderer is
      // compromised or invokes an obsolete preview-origin bridge.
      allowedOriginForGuestSession: () => null,
      authenticationEnabledForGuestSession: () => false,
      partitionForGuestSession: () => null,
      onGuestCreated: (partition, contents) =>
        previewAgentBrowser.registerGuest(partition, contents),
      audit: (action, outcome, metadata) => {
        try {
          store?.appendAudit('preview-webview', action, outcome, metadata);
        } catch {
          // Audit storage failure must not change an enforcement decision.
        }
      },
    });
    closeCoordinator = new CloseCoordinator(dialog, ipcMain);
    mainWindow = createWindow(services, closeCoordinator, packagedSmokeProfile === null);

    if (packagedSmokeProfile !== null) {
      const report = await runPackagedApplicationSmoke({
        profile: packagedSmokeProfile,
        webContents: mainWindow.webContents,
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
      title: 'Backup failed before quitting',
      message: 'Forgeboard could not create the final backup it makes when quitting.',
      detail: `${detail}\n\nYour work was saved, but no fresh backup copy was made.`,
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
      webviewTag: true,
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
  // Webviews are allowed only for sandboxed, partition-scoped local previews.
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!shouldAttachPreviewWebview(params as unknown as Record<string, unknown>)) {
      event.preventDefault();
      return;
    }
    hardenAttachingWebviewPreferences(webPreferences as unknown as Record<string, unknown>);
  });
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
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(isAllowedMicrophoneRequest(webContents, permission, details, true));
    },
  );
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    isAllowedMicrophoneRequest(webContents, permission, details, false),
  );
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => callback({ cancel: !isLoopbackNetworkUrl(details.url) }),
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const development = Boolean(process.env.ELECTRON_RENDERER_URL);
    // Vite injects its React refresh preamble as an inline development script. Keeping this
    // allowance development-only preserves the strict packaged renderer policy.
    const scriptPolicy = development
      ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
      : "script-src 'self'";
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
            `media-src 'self' ${PROJECT_VIDEO_SCHEME}:`,
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

function isAllowedMicrophoneRequest(
  webContents: Electron.WebContents | null,
  permission: string,
  details: unknown,
  requireAudioDetail: boolean,
): boolean {
  return allowsForgeboardMicrophone({
    permission,
    isMainWindow:
      webContents !== null &&
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      webContents === mainWindow.webContents,
    voiceCommandsEnabled: voiceCommandsAreEnabled(),
    details,
    requireAudioDetail,
  });
}

function voiceCommandsAreEnabled(): boolean {
  try {
    return store?.getSettings(createDefaultSettings()).voiceCommandsEnabled === true;
  } catch {
    return false;
  }
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
