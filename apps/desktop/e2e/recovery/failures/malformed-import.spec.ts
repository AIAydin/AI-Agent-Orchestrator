import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { launchDesktop, renameCanvasNode, watchExternalRequests } from '../../support/electron.js';

test('a malformed replace-import fails before confirmation and preserves local work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-malformed-import-e2e-'));
  const userDataDirectory = join(root, 'user-data');
  const malformedImportPath = join(root, 'malformed-forgeboard-export.json');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  await writeFile(malformedImportPath, '{"version": 1, "projects": [not-valid-json]\n');

  try {
    let session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    let page = session.page;
    watchExternalRequests(page, externalRequests);
    await page
      .getByRole('dialog', { name: 'Ready to build without wiring config files?' })
      .getByRole('button', { name: 'Use safe defaults' })
      .click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes');
    await page
      .locator('.template-section')
      .getByRole('button', { name: /Product brief/ })
      .click();
    await renameCanvasNode(
      page.getByRole('article', { name: /^Product brief: /u }),
      'Must survive malformed import',
    );
    await expect(
      page.getByRole('article', { name: 'Product brief: Must survive malformed import' }),
    ).toBeVisible();
    await page.locator('.project-switcher').click();
    await expect(
      page.getByRole('heading', { name: /Build software in a visual workshop/i }),
    ).toBeVisible();

    await installImportDialogHarness(electronApp, malformedImportPath);
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-modal');
    await settings.getByRole('button', { name: 'Data & privacy' }).click();
    await settings.getByLabel('How to import').selectOption('replace');
    await settings.getByRole('button', { name: 'Choose export file' }).click();

    await expect(page.locator('.error-toast[role="alert"]')).toContainText(
      'The selected file is not a readable Forgeboard export. It may be damaged.',
    );
    await expect(settings.getByRole('region', { name: 'Confirm local data import' })).toHaveCount(
      0,
    );
    expect(await importDialogState(electronApp)).toMatchObject({
      confirmationCalls: 0,
      openDialog: {
        title: 'Import local data',
        properties: ['openFile'],
      },
    });
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('.recent-list button')).toHaveCount(1);

    await electronApp.close();
    electronApp = null;

    session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    page = session.page;
    watchExternalRequests(page, externalRequests);
    await expect(page.locator('.setup-shell')).toHaveCount(0);
    await expect(page.locator('.recent-list button')).toHaveCount(1);
    await page.locator('.recent-list button').click();
    await expect(
      page.getByRole('article', { name: 'Product brief: Must survive malformed import' }),
    ).toBeVisible();
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

interface ImportDialogState {
  confirmationCalls: number;
  openDialog: { properties?: string[]; title?: string } | null;
}

async function installImportDialogHarness(
  app: ElectronApplication,
  selectedPath: string,
): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardMalformedImportDialogs?: ImportDialogState;
    };
    state.__forgeboardMalformedImportDialogs = { confirmationCalls: 0, openDialog: null };
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as { properties?: string[]; title?: string };
        const current = state.__forgeboardMalformedImportDialogs;
        if (current !== undefined) {
          current.openDialog = { properties: options.properties, title: options.title };
        }
        return Promise.resolve({ canceled: false, filePaths: [path] });
      },
    });
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: () => {
        const current = state.__forgeboardMalformedImportDialogs;
        if (current !== undefined) current.confirmationCalls += 1;
        return Promise.resolve({ response: 1, checkboxChecked: false });
      },
    });
  }, selectedPath);
}

async function importDialogState(app: ElectronApplication): Promise<ImportDialogState | null> {
  return await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardMalformedImportDialogs?: ImportDialogState;
    };
    return state.__forgeboardMalformedImportDialogs ?? null;
  });
}
