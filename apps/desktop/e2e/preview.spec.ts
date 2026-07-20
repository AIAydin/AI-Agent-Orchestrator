import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

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
    const app = session.app;
    electronApp = app;
    const page = session.page;
    const previewServerPath = resolve(import.meta.dirname, 'scripts', 'preview-server.mjs');
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();

    await test.step('the development command and preview network range are configured in Settings', async () => {
      await expect(
        page.getByRole('heading', {
          name: /Build software in a visual workshop/i,
        }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await settings.getByRole('button', { name: /Git & previews/ }).click();
      const command = settings.getByRole('group', {
        name: 'Development server',
      });
      await command.getByLabel('Executable').fill(process.execPath);
      await command.getByLabel('Arguments').fill(previewServerPath);
      await settings.getByLabel('Preview port start').fill('44000');
      await settings.getByLabel('Preview port end').fill('44050');
      await settings.getByLabel('Trusted preview hosts').fill('127.0.0.1, localhost');
      await settings.getByRole('button', { name: /Save settings/ }).click();
      await expect(settings).toBeHidden();
    });

    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Web preview/ })
      .click();
    const webNode = page.getByRole('article', {
      name: 'Web preview: Web preview',
    });
    await expect(webNode).toBeVisible();
    await webNode.click();
    const preview = page.getByRole('region', { name: 'Preview configuration' });
    await expect(preview).toContainText(formatCommandPart(process.execPath));
    await preview.getByLabel('Project folder').fill('.');
    await preview.getByLabel('Health check path').fill('/health');
    await preview.getByLabel('First page to open').fill('/initial');
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

    await test.step('start waits for real readiness and opens the sandboxed surface', async () => {
      await approveNextNativePreviewLaunch(
        app,
        { action: 'start', ...launchBinding },
        async () => await preview.getByRole('button', { name: 'Start preview' }).click(),
      );
      await expect(preview.locator('.preview-runtime-state')).toHaveText('ready', {
        timeout: 20_000,
      });
      await expect(preview.getByLabel('Preview console output').first()).toContainText(
        'preview-ready',
      );

      const surface = page.getByRole('dialog', {
        name: 'Local preview',
      });
      await expect(surface).toBeVisible();
      await expect
        .poll(async () => await readNativePreview(app), { timeout: 10_000 })
        .toMatchObject({
          heading: 'Preview server is ready',
          path: '/initial',
        });
      await surface.getByText('Console & errors').click();
      await expect(surface.getByLabel('Preview console output')).toContainText(
        'forgeboard-browser-console',
      );
    });

    await test.step('address changes are normalized and outbound navigation is blocked', async () => {
      const surface = page.getByRole('dialog', {
        name: 'Local preview',
      });
      const address = surface.getByLabel('Preview address');
      await address.fill('/next?device=desktop');
      await address.press('Enter');
      await expect
        .poll(async () => (await readNativePreview(app))?.path, {
          timeout: 10_000,
        })
        .toBe('/next?device=desktop');

      await address.fill('https://example.com/escape');
      await address.press('Enter');
      await expect(page.getByRole('alert')).toContainText('not trusted');
      await page.getByRole('alert').getByRole('button', { name: 'Dismiss error' }).click();

      await surface.getByRole('button', { name: 'Close preview' }).click();
    });

    await test.step('the same node can restart and stop without leaving a fake running state', async () => {
      await approveNextNativePreviewLaunch(
        app,
        { action: 'restart', ...launchBinding },
        async () => await preview.getByRole('button', { name: 'Restart' }).click(),
      );
      await expect(preview.locator('.preview-runtime-state')).toHaveText('ready', {
        timeout: 20_000,
      });
      await expect(page.getByRole('dialog', { name: 'Local preview' })).toBeVisible();
      await page
        .getByRole('dialog', { name: 'Local preview' })
        .getByRole('button', { name: 'Close preview' })
        .click();
      await expect(preview.locator('.preview-process-details dd').first()).toContainText('44');
      await preview.getByRole('button', { name: 'Stop' }).click();
      await expect(preview.locator('.preview-runtime-state')).toHaveText('stopped');
      await expect(preview.getByRole('button', { name: 'Start preview' })).toBeVisible();
    });

    await test.step('mobile preview exposes device, rotation, and side-by-side controls', async () => {
      await page
        .locator('.template-section')
        .getByRole('button', { name: /^Mobile preview/ })
        .click();
      await expect(
        page.getByRole('article', { name: 'Mobile preview: Mobile preview' }),
      ).toBeVisible();
      const mobilePreview = page.getByRole('region', {
        name: 'Preview configuration',
      });
      await expect(mobilePreview.getByLabel('Main device')).toHaveValue('iphone');
      await mobilePreview.getByRole('button', { name: 'Rotate to landscape' }).click();
      await mobilePreview.getByLabel('Compare side by side').check();
      await mobilePreview.getByLabel('Second device').selectOption('tablet');
      await expect(mobilePreview.getByLabel('Second device')).toHaveValue('tablet');

      await mobilePreview.getByLabel('Program to run').fill(process.execPath);
      await mobilePreview.getByLabel('Arguments, one per line').fill(previewServerPath);
      await mobilePreview.getByLabel('Health check path').fill('/health');
      await mobilePreview.getByLabel('First page to open').fill('/mobile');
      await approveNextNativePreviewLaunch(
        app,
        {
          action: 'start',
          projectRoot,
          cwd: projectRoot,
          source: 'Literal preview command configured on this canvas node in the UI',
          executable,
          executableSha256: await sha256File(executable),
          arguments: [previewServerPath],
          portRange: { start: 44_000, end: 44_050 },
          trustedHosts: ['127.0.0.1', 'localhost'],
        },
        async () => await mobilePreview.getByRole('button', { name: 'Start preview' }).click(),
      );
      await expect(mobilePreview.locator('.preview-runtime-state')).toHaveText('ready', {
        timeout: 20_000,
      });
      const mobileSurface = page.getByRole('dialog', {
        name: 'Local preview',
      });
      try {
        await expect
          .poll(
            async () =>
              await mobileSurface.locator('.preview-device-host[data-status="ready"]').count(),
            { timeout: 30_000 },
          )
          .toBe(2)
          .catch(async (cause: unknown) => {
            const fallback = await mobileSurface
              .locator('.preview-surface-fallback')
              .allTextContents();
            throw new Error(`Mobile surface status: ${JSON.stringify(fallback)}`, { cause });
          });
      } finally {
        if (await mobileSurface.isVisible()) {
          await mobileSurface.getByRole('button', { name: 'Close preview' }).click();
        }
        await mobilePreview.getByRole('button', { name: 'Stop' }).click();
        await expect(mobilePreview.locator('.preview-runtime-state')).toHaveText('stopped');
        await expect.poll(async () => await nativePreviewCount(app)).toBe(0);
      }
    });

    expect(externalRequests).toEqual([]);
  } finally {
    if (electronApp) await closeElectronAfterPreview(electronApp);
    await rm(userDataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test('an occupied preview range reports a real collision without spawning a preview', async () => {
  const userDataDirectory = await mkdtemp(joinPath(tmpdir(), 'forgeboard-preview-collision-e2e-'));
  const collision = await reserveContiguousPorts(2);
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    const previewServerPath = resolve(import.meta.dirname, 'scripts', 'preview-server.mjs');
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-modal');
    await settings.getByRole('button', { name: /Git & previews/ }).click();
    const command = settings.getByRole('group', { name: 'Development server' });
    await command.getByLabel('Executable').fill(process.execPath);
    await command.getByLabel('Arguments').fill(previewServerPath);
    await settings.getByLabel('Preview port start').fill(String(collision.start));
    await settings.getByLabel('Preview port end').fill(String(collision.end));
    await settings.getByLabel('Trusted preview hosts').fill('127.0.0.1, localhost');
    await settings.getByRole('button', { name: /Save settings/ }).click();
    await expect(settings).toBeHidden();

    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Web preview/ })
      .click();
    await page.getByRole('article', { name: 'Web preview: Web preview' }).click();
    const preview = page.getByRole('region', { name: 'Preview configuration' });
    await preview.getByLabel('Health check path').fill('/health');

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
      async () => await preview.getByRole('button', { name: 'Start preview' }).click(),
    );

    await expect(page.getByRole('alert')).toContainText(
      `Unable to reserve 1 loopback port(s) in ${String(collision.start)}-${String(collision.end)}.`,
    );
    await expect(preview.locator('.preview-runtime-state')).toHaveText('idle');
    await expect(preview.getByRole('button', { name: 'Start preview' })).toBeEnabled();
    await expect.poll(async () => await nativePreviewCount(session.app)).toBe(0);
    expect(collision.servers.every((server) => server.listening)).toBe(true);
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await Promise.all(collision.servers.map(async (server) => await closeServer(server)));
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

function joinPath(...parts: string[]): string {
  return parts.join(process.platform === 'win32' ? '\\' : '/');
}

async function nativePreviewCount(electronApp: ElectronApplication): Promise<number> {
  return await electronApp.evaluate(
    ({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((contents) => /^http:\/\/(?:127\.0\.0\.1|localhost):\d+/u.test(contents.getURL()))
        .length,
  );
}

async function closeElectronAfterPreview(electronApp: ElectronApplication): Promise<void> {
  const closed = electronApp.close().then(
    () => true,
    () => true,
  );
  const completed = await Promise.race([
    closed,
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 10_000)),
  ]);
  if (!completed) electronApp.process().kill('SIGKILL');
}

function formatCommandPart(value: string): string {
  return /^[A-Za-z0-9_./:=@+{}-]+$/u.test(value) ? value : JSON.stringify(value);
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
): Promise<{ heading: string | null; path: string | null } | null> {
  const result: unknown = await electronApp.evaluate(async ({ webContents }) => {
    const preview = webContents
      .getAllWebContents()
      .find((contents) => /^http:\/\/(?:127\.0\.0\.1|localhost):\d+/u.test(contents.getURL()));
    if (!preview) return null;
    const documentState: unknown = await preview.executeJavaScript(`({
      heading: document.querySelector('h1')?.textContent ?? null,
      path: document.querySelector('[data-testid="request-path"]')?.textContent ?? null
    })`);
    if (!documentState || typeof documentState !== 'object') return null;
    const record = documentState as Record<string, unknown>;
    return {
      heading: typeof record.heading === 'string' ? record.heading : null,
      path: typeof record.path === 'string' ? record.path : null,
    };
  });
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  return {
    heading: typeof record.heading === 'string' ? record.heading : null,
    path: typeof record.path === 'string' ? record.path : null,
  };
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
