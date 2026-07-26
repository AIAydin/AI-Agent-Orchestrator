import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from './support/electron.js';

/**
 * The preview node's start command no longer has a Settings or node-face editor, so this spec
 * proves what the UI still owns: a preview node embeds a real loopback page, and the device
 * controls on the node change the rendered stage — all without a single outbound request.
 */
test('preview nodes embed a loopback page and expose device controls from the canvas UI', async () => {
  const userDataDirectory = await mkdtemp(joinPath(tmpdir(), 'forgeboard-preview-e2e-'));
  let electronApp: ElectronApplication | null = null;
  let loopback: LoopbackPreviewServer | null = null;
  const externalRequests: string[] = [];

  try {
    loopback = await startLoopbackPreviewServer();
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Web preview/ })
      .click();
    const preview = page.getByRole('region', { name: 'Web preview' });
    await expect(preview).toBeVisible();
    await expect(preview.locator('.preview-face-status')).toHaveText('no address');

    const address = preview.getByLabel('Preview address');
    await address.fill(String(loopback.port));
    await address.press('Enter');
    await expect
      .poll(async () => await readEmbeddedPreview(session.app), { timeout: 20_000 })
      .toMatchObject({ heading: 'Preview server is ready' });

    await preview.getByRole('button', { name: 'Configure preview' }).click();
    await expect(preview.getByLabel('Main device')).toHaveValue('desktop');

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Mobile preview/ })
      .click();
    // Auto-placement drops the second node clear of the first, so give it the rail's space and
    // bring the whole canvas back into view before driving its controls.
    await page.getByRole('button', { name: 'Hide project sidebar' }).click();
    await page.getByRole('button', { name: 'Zoom to fit the canvas' }).click();
    const mobilePreview = page.getByRole('region', { name: 'Mobile preview' });
    await mobilePreview.getByRole('button', { name: 'Configure preview' }).click();
    await expect(mobilePreview.getByLabel('Main device')).toHaveValue('iphone');
    await mobilePreview.getByRole('button', { name: 'Rotate to landscape' }).click();
    await mobilePreview.getByLabel('Compare side by side').check();
    await mobilePreview.getByLabel('Second device').selectOption('tablet');
    await expect(mobilePreview.getByLabel('Second device')).toHaveValue('tablet');

    expect(externalRequests).toEqual([]);
    expect(loopback.externalHosts).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await loopback?.stop();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

interface LoopbackPreviewServer {
  readonly port: number;
  readonly externalHosts: readonly string[];
  stop(): Promise<void>;
}

async function startLoopbackPreviewServer(): Promise<LoopbackPreviewServer> {
  const externalHosts: string[] = [];
  const server: Server = createServer((request, response) => {
    const host = request.headers.host ?? '';
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(host)) externalHosts.push(host);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(
      '<!doctype html><html><head><title>Forgeboard local preview</title></head>' +
        '<body><h1>Preview server is ready</h1></body></html>',
    );
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  const listening = server.address();
  if (listening === null || typeof listening === 'string') {
    throw new Error('The loopback preview server did not report a port.');
  }
  return {
    port: listening.port,
    externalHosts,
    stop: async () =>
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

function joinPath(...parts: string[]): string {
  return parts.join(process.platform === 'win32' ? '\\' : '/');
}

async function readEmbeddedPreview(
  electronApp: ElectronApplication,
): Promise<{ heading: string | null } | null> {
  const result: unknown = await electronApp.evaluate(async ({ webContents }) => {
    const preview = webContents
      .getAllWebContents()
      .find((contents) => /^http:\/\/(?:127\.0\.0\.1|localhost):\d+/u.test(contents.getURL()));
    if (!preview) return null;
    const state: unknown = await preview.executeJavaScript(`({
      heading: document.querySelector('h1')?.textContent ?? null
    })`);
    return state;
  });
  if (!result || typeof result !== 'object') return null;
  const heading = (result as Record<string, unknown>).heading;
  return { heading: typeof heading === 'string' ? heading : null };
}
