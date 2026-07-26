import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeElectronAfterTest,
  closeProjectFromSwitcher,
  launchDesktop,
  renameCanvasNode,
  watchExternalRequests,
} from './support/electron.js';

test('immediate app and project closes preserve the latest canvas revision', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-close-persistence-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');

    await test.step('a dirty node is flushed when Electron closes before autosave', async () => {
      await page.locator('.template-section').getByRole('button', { name: /^Note/ }).click();
      await renameCanvasNode(
        page.getByRole('article', { name: /^Note: /u }),
        'Immediate quit proof',
      );

      await electronApp?.close();
      electronApp = null;
    });

    const secondSession = await launchDesktop(userDataDirectory);
    electronApp = secondSession.app;
    page = secondSession.page;
    watchExternalRequests(page, externalRequests);

    await test.step('the same local profile reopens the flushed revision', async () => {
      await expect(page.locator('.setup-shell')).toHaveCount(0);
      await expect(page.locator('.recent-list button')).toHaveCount(1);
      await page.locator('.recent-list button').click();

      await expect(page.locator('.canvas-title')).toContainText('1 nodes · 0 connections');
      await expect(page.getByRole('article', { name: 'Note: Immediate quit proof' })).toBeVisible();
    });

    await test.step('an immediate in-app project close also flushes before reopening', async () => {
      await page
        .locator('.template-section')
        .getByRole('button', { name: /^Product brief/ })
        .click();
      await renameCanvasNode(
        page.getByRole('article', { name: /^Product brief: /u }),
        'Immediate project-close proof',
      );
      await closeProjectFromSwitcher(page);

      await expect(page.locator('.recent-list button')).toHaveCount(1);
      await page.locator('.recent-list button').click();

      await expect(page.locator('.canvas-title')).toContainText('2 nodes · 0 connections');
      await expect(page.getByRole('article', { name: 'Note: Immediate quit proof' })).toBeVisible();
      await expect(
        page.getByRole('article', { name: 'Product brief: Immediate project-close proof' }),
      ).toBeVisible();
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
    await expect(access(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
