import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
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
    const screenshotPath = resolve(userDataDirectory, 'preview-capture.png');
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
    await preview.getByLabel('Readiness path').fill('/health');
    await preview.getByLabel('Initial URL path').fill('/initial');
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
        name: 'Secure loopback preview',
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
        name: 'Secure loopback preview',
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

      await chooseScreenshotPath(app, screenshotPath);
      await surface.getByRole('button', { name: 'Save screenshot' }).click();
      await expect(surface.getByRole('status')).toHaveText('Screenshot saved.');
      await expect.poll(async () => (await stat(screenshotPath)).size).toBeGreaterThan(0);
      await surface.getByRole('button', { name: 'Close preview surface' }).click();
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
      await expect(page.getByRole('dialog', { name: 'Secure loopback preview' })).toBeVisible();
      await page
        .getByRole('dialog', { name: 'Secure loopback preview' })
        .getByRole('button', { name: 'Close preview surface' })
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
      await expect(mobilePreview.getByLabel('Device viewport')).toHaveValue('iphone');
      await mobilePreview.getByRole('button', { name: 'Rotate' }).click();
      await mobilePreview.getByLabel('Side by side').check();
      await mobilePreview.getByLabel('Secondary device viewport').selectOption('tablet');
      await expect(mobilePreview.getByLabel('Secondary device viewport')).toHaveValue('tablet');

      await mobilePreview.getByLabel('Preview executable').fill(process.execPath);
      await mobilePreview.getByLabel('Preview arguments').fill(previewServerPath);
      await mobilePreview.getByLabel('Readiness path').fill('/health');
      await mobilePreview.getByLabel('Initial URL path').fill('/mobile');
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
        name: 'Secure loopback preview',
      });
      try {
        await expect(mobileSurface.getByText('Touch emulation active'))
          .toHaveCount(2, { timeout: 30_000 })
          .catch(async (cause: unknown) => {
            const fallback = await mobileSurface
              .locator('.preview-surface-fallback')
              .allTextContents();
            throw new Error(`Mobile surface status: ${JSON.stringify(fallback)}`, { cause });
          });
      } finally {
        if (await mobileSurface.isVisible()) {
          await mobileSurface.getByRole('button', { name: 'Close preview surface' }).click();
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

async function chooseScreenshotPath(
  electronApp: ElectronApplication,
  screenshotPath: string,
): Promise<void> {
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showSaveDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePath: selectedPath }),
    });
  }, screenshotPath);
}
