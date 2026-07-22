import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import type { ForgeboardApi } from '../../src/shared/api.js';
import { launchDesktop, watchExternalRequests } from '../support/electron.js';

test('an existing non-Git folder can be initialized safely from the project UI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-project-onboarding-e2e-'));
  const userDataDirectory = join(root, 'user-data');
  const projectPath = join(root, 'existing-project');
  const existingFile = join(projectPath, 'existing.txt');
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  await mkdir(projectPath, { recursive: true });
  await writeFile(existingFile, 'existing content stays unchanged\n');

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await page
      .getByRole('dialog', { name: 'Ready to build without wiring config files?' })
      .getByRole('button', { name: 'Use safe defaults' })
      .click();
    await chooseRepository(electronApp, projectPath);
    await page.getByRole('button', { name: /Open a project folder/i }).click();

    await expect(page.locator('.project-switcher')).toContainText('existing-project');
    await expect(page.getByText('Git not set up yet')).toBeVisible();
    const initialize = page.getByRole('button', { name: 'Set up Git…' });
    await expect(initialize).toBeVisible();
    await expect(page.getByText('Your files stay exactly as they are.')).toBeVisible();

    await answerNativeConfirmation(electronApp, 0);
    await initialize.click();
    await expect(initialize).toBeEnabled();
    await expect(access(join(projectPath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });

    await answerNativeConfirmation(electronApp, 1);
    await initialize.click();
    await expect(initialize).toBeHidden();
    await expect(page.locator('.repository-summary')).toContainText('main');
    await expect(access(join(projectPath, '.git'))).resolves.toBeUndefined();
    await expect(readFile(existingFile, 'utf8')).resolves.toBe(
      'existing content stays unchanged\n',
    );

    const audit = await page.evaluate(async () => {
      const forgeboard = (globalThis as typeof globalThis & { forgeboard: ForgeboardApi })
        .forgeboard;
      return await forgeboard.audit.list({ limit: 10 });
    });
    expect(audit).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ category: 'git', action: 'initialize', outcome: 'denied' }),
        expect.objectContaining({ category: 'git', action: 'initialize', outcome: 'allowed' }),
      ]),
    });
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function chooseRepository(
  electronApp: ElectronApplication,
  projectPath: string,
): Promise<void> {
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePaths: [selectedPath] }),
    });
  }, projectPath);
}

async function answerNativeConfirmation(
  electronApp: ElectronApplication,
  response: 0 | 1,
): Promise<void> {
  await electronApp.evaluate(({ dialog }, selectedResponse) => {
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: () => Promise.resolve({ response: selectedResponse, checkboxChecked: false }),
    });
  }, response);
}
