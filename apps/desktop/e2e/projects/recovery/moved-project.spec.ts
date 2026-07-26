import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  runCanvasNodeContextAction,
  watchExternalRequests,
} from '../../support/electron.js';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('a moved project is detected, reviewed, and relinked entirely in the UI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-moved-project-e2e-'));
  const userDataDirectory = join(root, 'user-data');
  const originalPath = join(root, 'project-before-move');
  const movedPath = join(root, 'project-after-move');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  await mkdir(originalPath, { recursive: true });
  await writeFile(join(originalPath, 'README.md'), '# Project that will move\n');
  const canonicalOriginalPath = await realpath(originalPath);

  try {
    let session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    let page = session.page;
    watchExternalRequests(page, externalRequests);
    await page
      .getByRole('dialog', { name: 'Ready to build without wiring config files?' })
      .getByRole('button', { name: 'Use safe defaults' })
      .click();

    await selectNextFolder(electronApp, originalPath);
    await page.getByRole('button', { name: /Open a project folder/i }).click();
    await expect(page.locator('.project-switcher')).toContainText('project-before-move');
    await expect(page.locator('.canvas-title')).toContainText('0 nodes');
    await page.keyboard.press(`${shortcutModifier}+K`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    // A product brief, not an agent: agent nodes launch a real CLI session the moment they
    // appear, which would tie this recovery proof to the agents installed on this computer.
    await palette.getByPlaceholder('Search actions…').fill('Add a product brief');
    await page.keyboard.press('Enter');
    const briefNode = page.getByRole('article', { name: /^Product brief: /u });
    await expect(briefNode).toBeVisible();
    await runCanvasNodeContextAction(page, briefNode, 'Delete');
    await expect(briefNode).toHaveCount(0);

    await electronApp.close();
    electronApp = null;
    await rename(originalPath, movedPath);
    const canonicalMovedPath = await realpath(movedPath);

    session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    page = session.page;
    watchExternalRequests(page, externalRequests);
    await expect(page.getByText('Missing folder')).toBeVisible();
    const locate = page.getByRole('button', {
      name: 'Locate moved repository for project-before-move',
    });

    await selectNextFolder(electronApp, movedPath);
    await locate.click();
    const review = page.getByRole('dialog', { name: 'Confirm moved project' });
    await expect(review).toBeVisible();
    await expect(review).toContainText(canonicalOriginalPath);
    await expect(review).toContainText(canonicalMovedPath);
    await expect(review).toContainText('Nothing unusual found in this folder.');
    await expect(review).toContainText(
      'Confirming keeps this project’s canvas, snapshots, and run records.',
    );
    expect(await selectedFolderDialog(electronApp)).toMatchObject({
      title: 'Locate moved repository',
      buttonLabel: 'Check this folder',
      properties: ['openDirectory'],
    });

    await review.getByRole('button', { name: 'Cancel' }).click();
    await expect(review).toBeHidden();
    await expect(page.getByText('Missing folder')).toBeVisible();

    await selectNextFolder(electronApp, movedPath);
    await locate.click();
    await page
      .getByRole('dialog', { name: 'Confirm moved project' })
      .getByRole('button', { name: 'Confirm new location' })
      .click();

    await expect(page.locator('.project-switcher')).toContainText('project-after-move');
    await expect(page.locator('.canvas-title')).toContainText('0 nodes');
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await page.keyboard.press(`${shortcutModifier}+Z`);
    await expect(page.getByRole('article', { name: /^Product brief: /u })).toBeVisible();
    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(root, { force: true, recursive: true });
  }
});

interface FolderDialogRecord {
  readonly buttonLabel?: string;
  readonly properties?: string[];
  readonly title?: string;
}

async function selectNextFolder(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardMovedProjectDialog?: FolderDialogRecord;
    };
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as FolderDialogRecord;
        state.__forgeboardMovedProjectDialog = {
          buttonLabel: options.buttonLabel,
          properties: options.properties,
          title: options.title,
        };
        return Promise.resolve({ canceled: false, filePaths: [path] });
      },
    });
  }, selectedPath);
}

async function selectedFolderDialog(app: ElectronApplication): Promise<FolderDialogRecord | null> {
  return await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardMovedProjectDialog?: FolderDialogRecord;
    };
    return state.__forgeboardMovedProjectDialog ?? null;
  });
}
