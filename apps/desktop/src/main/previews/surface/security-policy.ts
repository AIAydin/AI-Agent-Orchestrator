import type { Session, WebContents } from 'electron';

import { isAllowedSurfaceRequest } from './url-policy.js';

export function installPreviewSurfaceSecurity(
  webContents: WebContents,
  previewSession: Session,
  allowed: URL,
): () => void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, candidate) => {
    if (!isAllowedSurfaceRequest(candidate, allowed)) event.preventDefault();
  });
  webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedSurfaceRequest(event.url, allowed)) event.preventDefault();
  });
  webContents.on('will-attach-webview', (event) => event.preventDefault());
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const preventDownload = (event: Electron.Event): void => event.preventDefault();
  previewSession.on('will-download', preventDownload);
  previewSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => callback({ cancel: !isAllowedSurfaceRequest(details.url, allowed) }),
  );
  return () => {
    previewSession.removeListener('will-download', preventDownload);
    previewSession.setPermissionCheckHandler(null);
    previewSession.setPermissionRequestHandler(null);
    previewSession.webRequest.onBeforeRequest(null);
  };
}
