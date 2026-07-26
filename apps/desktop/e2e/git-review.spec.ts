import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import type { IpcResult, Project } from '../src/shared/application/contracts.js';
import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from './support/electron.js';

test('authoritative Git review stages, unstages, and discloses the exact local commit', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-git-review-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-modal');
    await settings.getByRole('button', { name: /Git & previews/ }).click();
    await settings.getByLabel('Git identity name').fill('Forgeboard E2E Reviewer');
    await settings.getByLabel('Git identity email').fill('reviewer@forgeboard.invalid');
    await settings.getByRole('button', { name: /Save settings/ }).click();
    await expect(settings).toBeHidden();

    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    const projectPath = await page.evaluate(async () => {
      const forgeboard = (
        window as unknown as {
          forgeboard: { projects: { recent(): Promise<IpcResult<Project[]>> } };
        }
      ).forgeboard;
      const result = await forgeboard.projects.recent();
      if (!result.ok) throw new Error(result.error.message);
      const demo = result.value.find((project) => !project.missing);
      if (demo === undefined) throw new Error('The local demo project is missing.');
      return demo.path;
    });
    const headBefore = gitHead(projectPath);
    await writeFile(join(projectPath, 'review-e2e.txt'), 'authoritative review proof\n', 'utf8');

    await page.locator('.command-bar').getByRole('button', { name: 'Changes' }).click();
    const dialog = page.getByRole('dialog', { name: /Review changes in forgeboard-demo/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('review-e2e.txt', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText('New files').locator('..')).toContainText('1');

    await dialog.getByRole('button', { name: 'Add review-e2e.txt to commit' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Remove review-e2e.txt from commit' }),
    ).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Changes in review-e2e.txt' })).toContainText(
      'authoritative review proof',
    );

    await dialog.getByLabel('Commit message').fill('Prove authoritative Git review');
    await dialog.getByRole('button', { name: /Review commit/ }).click();
    const disclosure = page.getByRole('alertdialog', { name: 'Review your commit' });
    await expect(disclosure).toContainText('Forgeboard E2E Reviewer');
    await expect(disclosure).toContainText('reviewer@forgeboard.invalid');
    await expect(disclosure).toContainText('Prove authoritative Git review');
    await expect(disclosure).toContainText('review-e2e.txt');
    expect(gitHead(projectPath)).toBe(headBefore);

    await disclosure.getByRole('button', { name: 'Go back' }).click();
    await dialog.getByRole('button', { name: 'Remove review-e2e.txt from commit' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Add review-e2e.txt to commit' }),
    ).toBeVisible();
    expect(gitHead(projectPath)).toBe(headBefore);
    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

function gitHead(repository: string): string {
  return execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}
