import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from './support/electron.js';
import {
  approveNextNativePreviewLaunch,
  type NativePreviewConfirmationBinding,
} from './support/preview-confirmation.js';

/**
 * The preview node owns its own start command: it is typed into the node's
 * config popover, never into Settings. This spec proves the whole node-hosted
 * path — the owner-bound native confirmation of the exact executable, the dev
 * server it then runs, the plain typed address that needs no server at all,
 * and the device controls — without a single outbound request.
 */
test('a preview node starts its own reviewed dev server and still embeds a typed loopback port', async () => {
  const userDataDirectory = await mkdtemp(joinPath(tmpdir(), 'forgeboard-preview-e2e-'));
  let electronApp: ElectronApplication | null = null;
  let loopback: LoopbackPreviewServer | null = null;
  const externalRequests: string[] = [];

  try {
    loopback = await startLoopbackPreviewServer();
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    const previewServerPath = resolve(import.meta.dirname, 'scripts', 'preview-server.mjs');
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await setPreviewPortRange(page, 44_000, 44_050);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Web preview/ })
      .click();
    const preview = page.getByRole('region', { name: 'Web preview' });
    await expect(preview).toBeVisible();
    await expect(preview.locator('.preview-face-status')).toHaveText('no address');

    await typeStartCommand(preview, process.execPath, previewServerPath);

    const projectRoot = await realpath(joinPath(userDataDirectory, 'demo', 'artemis-demo'));
    const executable = await realpath(process.execPath);
    const launchBinding = {
      projectRoot,
      cwd: projectRoot,
      source: 'Literal preview command configured on this canvas node in the UI',
      executable,
      executableSha256: await sha256File(executable),
      arguments: [previewServerPath],
      portRange: { start: 44_000, end: 44_050 },
      trustedHosts: ['127.0.0.1', 'localhost'],
    } satisfies Omit<NativePreviewConfirmationBinding, 'action'>;

    await approveNextNativePreviewLaunch(
      session.app,
      { action: 'start', ...launchBinding },
      async () => await preview.getByRole('button', { name: 'Start dev server' }).click(),
    );
    await expect(preview.getByLabel('Preview address')).toHaveValue(/^44\d{3}$/u, {
      timeout: 20_000,
    });
    await expect(preview.locator('.preview-face-status')).toHaveText('ready', { timeout: 20_000 });
    await expect
      .poll(async () => await readEmbeddedPreview(session.app), { timeout: 10_000 })
      .toMatchObject({ heading: 'Preview server is ready' });

    await preview.getByRole('button', { name: 'Stop dev server' }).click();
    await expect(preview.getByRole('button', { name: 'Start dev server' })).toBeVisible();

    const address = preview.getByLabel('Preview address');
    await address.fill(String(loopback.port));
    await address.press('Enter');
    await expect
      .poll(async () => await readEmbeddedPreview(session.app), { timeout: 20_000 })
      .toMatchObject({ heading: 'A typed port is enough' });

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

test('an occupied preview range reports a real collision without spawning a preview', async () => {
  const userDataDirectory = await mkdtemp(joinPath(tmpdir(), 'forgeboard-preview-collision-e2e-'));
  const collision = await reserveContiguousPorts(2);
  let electronApp: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    const previewServerPath = resolve(import.meta.dirname, 'scripts', 'preview-server.mjs');
    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await setPreviewPortRange(page, collision.start, collision.end);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Web preview/ })
      .click();
    const preview = page.getByRole('region', { name: 'Web preview' });
    await typeStartCommand(preview, process.execPath, previewServerPath);

    const projectRoot = await realpath(joinPath(userDataDirectory, 'demo', 'artemis-demo'));
    const executable = await realpath(process.execPath);
    await approveNextNativePreviewLaunch(
      session.app,
      {
        action: 'start',
        projectRoot,
        cwd: projectRoot,
        source: 'Literal preview command configured on this canvas node in the UI',
        executable,
        executableSha256: await sha256File(executable),
        arguments: [previewServerPath],
        portRange: { start: collision.start, end: collision.end },
        trustedHosts: ['127.0.0.1', 'localhost'],
      },
      async () => await preview.getByRole('button', { name: 'Start dev server' }).click(),
    );

    await expect(page.locator('.error-toast')).toContainText(
      `Unable to reserve 1 loopback port(s) in ${String(collision.start)}-${String(collision.end)}.`,
    );
    await expect(preview.getByRole('button', { name: 'Start dev server' })).toBeEnabled();
    expect(collision.servers.every((server) => server.listening)).toBe(true);
  } finally {
    await closeElectronAfterTest(electronApp);
    await Promise.all(collision.servers.map(async (server) => await closeServer(server)));
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

/** Types the dev-server command into the node's own config popover, then closes it. */
async function typeStartCommand(
  preview: Locator,
  executable: string,
  ...args: string[]
): Promise<void> {
  const configure = preview.getByRole('button', { name: 'Configure preview' });
  await configure.click();
  await preview.getByLabel('Start command').fill(commandLine(executable, ...args));
  await configure.click();
  await expect(preview.getByLabel('Start command')).toHaveCount(0);
}

/** Mirrors the node face's own one-line command formatting. */
function commandLine(...tokens: string[]): string {
  return tokens
    .map((token) => {
      if (!/[\s"']/u.test(token)) return token;
      return token.includes('"') ? `'${token}'` : `"${token}"`;
    })
    .join(' ');
}

async function setPreviewPortRange(page: Page, start: number, end: number): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  await settings.getByLabel('Preview port start').fill(String(start));
  await settings.getByLabel('Preview port end').fill(String(end));
  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
}

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
      '<!doctype html><html><head><title>Artemis local preview</title></head>' +
        '<body><h1>A typed port is enough</h1></body></html>',
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

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Uint8Array>) {
    digest.update(chunk);
  }
  return digest.digest('hex');
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

async function reserveContiguousPorts(count: number): Promise<{
  readonly start: number;
  readonly end: number;
  readonly servers: readonly SocketServer[];
}> {
  for (let start = 45_000; start <= 65_000 - count; start += count) {
    const servers: SocketServer[] = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        const server = createSocketServer();
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(start + offset, '127.0.0.1', () => {
            server.removeListener('error', rejectListen);
            resolveListen();
          });
        });
        servers.push(server);
      }
      return { start, end: start + count - 1, servers };
    } catch {
      await Promise.all(servers.map(async (server) => await closeServer(server)));
    }
  }
  throw new Error('Could not reserve a contiguous collision-test port range.');
}

async function closeServer(server: SocketServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
