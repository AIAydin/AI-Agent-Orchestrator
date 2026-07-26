import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from './support/electron.js';
import {
  approveNextNativePreviewLaunch,
  type NativePreviewConfirmationBinding,
} from './support/preview-confirmation.js';

test('web and mobile preview nodes run a sandboxed loopback server from UI configuration', async () => {
  const userDataDirectory = await mkdtemp(joinPath(tmpdir(), 'forgeboard-preview-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    const previewServerPath = resolve(import.meta.dirname, 'scripts', 'preview-server.mjs');
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await configureDevelopmentServer(page, {
      executable: process.execPath,
      arguments_: previewServerPath,
      portStart: 44_000,
      portEnd: 44_050,
    });
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Web preview/ })
      .click();
    const preview = page.getByRole('region', { name: 'Web preview' });
    await expect(preview).toBeVisible();

    const projectRoot = await realpath(joinPath(userDataDirectory, 'demo', 'forgeboard-demo'));
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
    await expect(preview.locator('.preview-face-status')).toHaveText('ready', {
      timeout: 20_000,
    });
    await expect
      .poll(async () => await readNativePreview(session.app), { timeout: 10_000 })
      .toMatchObject({ heading: 'Preview server is ready' });

    await preview.getByRole('button', { name: 'Configure preview' }).click();
    await expect(preview.getByLabel('Main device')).toHaveValue('desktop');
    await preview.getByRole('button', { name: 'Stop dev server' }).click();
    await expect(preview.getByRole('button', { name: 'Start dev server' })).toBeVisible();

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Mobile preview/ })
      .click();
    const mobilePreview = page.getByRole('region', { name: 'Mobile preview' });
    await mobilePreview.getByRole('button', { name: 'Configure preview' }).click();
    await expect(mobilePreview.getByLabel('Main device')).toHaveValue('iphone');
    await mobilePreview.getByRole('button', { name: 'Rotate to landscape' }).click();
    await mobilePreview.getByLabel('Compare side by side').check();
    await mobilePreview.getByLabel('Second device').selectOption('tablet');
    await expect(mobilePreview.getByLabel('Second device')).toHaveValue('tablet');
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
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
    await configureDevelopmentServer(page, {
      executable: process.execPath,
      arguments_: previewServerPath,
      portStart: collision.start,
      portEnd: collision.end,
    });
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Web preview/ })
      .click();
    const preview = page.getByRole('region', { name: 'Web preview' });
    const projectRoot = await realpath(joinPath(userDataDirectory, 'demo', 'forgeboard-demo'));
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

    await expect(page.getByRole('alert')).toContainText(
      `Unable to reserve 1 loopback port(s) in ${String(collision.start)}-${String(collision.end)}.`,
    );
    await expect(preview.getByRole('button', { name: 'Start dev server' })).toBeEnabled();
    expect(collision.servers.every((server) => server.listening)).toBe(true);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await Promise.all(collision.servers.map(async (server) => await closeServer(server)));
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function configureDevelopmentServer(
  page: Page,
  input: {
    executable: string;
    arguments_: string;
    portStart: number;
    portEnd: number;
  },
): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  const command = settings.getByRole('group', { name: 'Development server' });
  await command.getByLabel('Executable', { exact: true }).fill(input.executable);
  await command.getByLabel('Arguments').fill(input.arguments_);
  await settings.getByLabel('Preview port start').fill(String(input.portStart));
  await settings.getByLabel('Preview port end').fill(String(input.portEnd));
  await settings.getByLabel('Trusted preview hosts').fill('127.0.0.1, localhost');
  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
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

async function readNativePreview(
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
  readonly servers: readonly Server[];
}> {
  for (let start = 45_000; start <= 65_000 - count; start += count) {
    const servers: Server[] = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        const server = createServer();
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
