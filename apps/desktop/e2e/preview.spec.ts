import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
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
    await preview.getByLabel('Readiness path').fill('/health');
    await preview.getByLabel('Initial URL path').fill('/initial');
    const projectRoot = await realpath(joinPath(userDataDirectory, 'demo', 'forgeboard-demo'));
    const executable = await realpath(process.execPath);
    const launchBinding = {
      projectRoot,
      cwd: projectRoot,
      source: 'Development command configured in Settings',
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
      await expect(preview.getByLabel('Preview process logs')).toContainText('preview-ready');

      const surface = page.getByRole('dialog', { name: 'Loopback preview' });
      await expect(surface).toBeVisible();
      const frame = surface.frameLocator('iframe').first();
      await expect(frame.getByRole('heading', { name: 'Preview server is ready' })).toBeVisible();
      await expect(frame.getByTestId('request-path')).toHaveText('/initial');
    });

    await test.step('address changes are normalized and outbound navigation is blocked', async () => {
      const surface = page.getByRole('dialog', { name: 'Loopback preview' });
      const address = surface.getByLabel('Preview address');
      await address.fill('/next?device=desktop');
      await address.press('Enter');
      await expect(surface.frameLocator('iframe').first().getByTestId('request-path')).toHaveText(
        '/next?device=desktop',
      );

      await address.fill('https://example.com/escape');
      await address.press('Enter');
      await expect(page.getByRole('alert')).toContainText('not trusted');
      await page.getByRole('alert').getByRole('button', { name: 'Dismiss error' }).click();
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
      await expect(page.getByRole('dialog', { name: 'Loopback preview' })).toBeVisible();
      await page
        .getByRole('dialog', { name: 'Loopback preview' })
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
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

function joinPath(...parts: string[]): string {
  return parts.join(process.platform === 'win32' ? '\\' : '/');
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
