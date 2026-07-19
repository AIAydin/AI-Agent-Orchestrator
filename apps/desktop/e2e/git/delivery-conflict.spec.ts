import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import {
  approveNextNativeAgentLaunch,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';
import { currentProjectPath, git } from './connections/repository.js';

const IDENTITY = {
  name: 'Forgeboard Conflict E2E',
  email: 'conflict-e2e@forgeboard.invalid',
};

test('a real conflicted agent worktree is blocked before Git delivery review', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-delivery-conflict-e2e-'));
  const managedWorktreeRoot = join(await realpath(userDataDirectory), 'managed-worktrees');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await configureGit(page, managedWorktreeRoot);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    const primaryPath = await currentProjectPath(page);
    const baseBranch = git(primaryPath, ['branch', '--show-current']);

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Agent/ })
      .click();
    const agentNode = page.getByRole('article', { name: 'Agent: Agent' });
    await agentNode.click();
    const runConfiguration = page.getByRole('region', { name: 'Agent run settings' });
    await runConfiguration.getByLabel('Agent to run').selectOption('test-agent');
    await runConfiguration.getByLabel('Permission profile').selectOption('worktree-write');
    await runConfiguration
      .getByLabel('Prompt')
      .fill('Create the deterministic file used to exercise delivery conflict handling.');
    await runConfiguration.getByRole('button', { name: /Review & run/ }).click();
    const disclosure = page.getByRole('dialog', { name: 'Review this run before it starts' });
    await approveNextNativeAgentLaunch(session.app, disclosure, 'test-agent', async () => {
      await disclosure.getByRole('button', { name: 'Approve and start' }).click();
    });
    await expect(agentNode.locator('.node-status-label')).toContainText('succeeded', {
      timeout: 20_000,
    });

    const worktreePath = await onlyManagedWorktree(primaryPath);
    const changedFile = git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])
      .split('\n')
      .map((line) => line.slice(3))
      .find(Boolean);
    if (!changedFile) throw new Error('The deterministic agent did not create a changed file.');
    git(worktreePath, ['add', '--', changedFile]);
    commit(worktreePath, 'Commit agent side of conflict');

    await writeFile(join(primaryPath, changedFile), 'primary-side conflict\n', 'utf8');
    git(primaryPath, ['add', '--', changedFile]);
    commit(primaryPath, 'Commit primary side of conflict');
    expect(() => git(worktreePath, ['merge', '--no-edit', baseBranch])).toThrow();
    expect(git(worktreePath, ['diff', '--name-only', '--diff-filter=U'])).toBe(changedFile);

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Git \/ PR/ })
      .click();
    const gitNode = page.getByRole('article', { name: 'Git / PR: Git / PR' });
    await gitNode.click();
    const delivery = page.getByRole('region', { name: 'Publish changes' });
    const runPicker = delivery.getByLabel('Finished agent run');
    await expect.poll(async () => await runPicker.locator('option').count()).toBeGreaterThan(1);
    await runPicker.selectOption({ index: 1 });
    await delivery.getByRole('button', { name: 'Check changes' }).click();

    await expect(delivery.locator('.git-pr-state.error')).toContainText(
      'Resolve managed worktree conflicts before delivery.',
    );
    await expect(delivery.getByRole('button', { name: 'Review push' })).toBeDisabled();
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function configureGit(page: Page, managedWorktreeRoot: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  await settings.getByLabel('Managed worktree location').fill(managedWorktreeRoot);
  await settings.getByLabel('Git identity name').fill(IDENTITY.name);
  await settings.getByLabel('Git identity email').fill(IDENTITY.email);
  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
}

async function onlyManagedWorktree(primaryPath: string): Promise<string> {
  const primary = await realpath(primaryPath);
  const candidates = git(primaryPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  const managed: string[] = [];
  for (const candidate of candidates) {
    if ((await realpath(candidate)) !== primary) managed.push(candidate);
  }
  expect(managed).toHaveLength(1);
  return managed[0] ?? '';
}

function commit(repository: string, message: string): void {
  git(repository, [
    '-c',
    `user.name=${IDENTITY.name}`,
    '-c',
    `user.email=${IDENTITY.email}`,
    'commit',
    '-m',
    message,
  ]);
}
