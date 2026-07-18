import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  approveNextNativeAgentLaunch,
  launchDesktop,
  watchExternalRequests,
} from './support/electron.js';

test('the deterministic agent requires approval and reports its real local work', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-agent-e2e-'));
  const configuredWorktreeRoot = join(await realpath(userDataDirectory), 'ui-configured-worktrees');
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();

    await test.step('the writable worktree location is configured in the UI', async () => {
      await expect(
        page.getByRole('heading', {
          name: /Build software in a visual workshop/i,
        }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await settings.getByRole('button', { name: /Git & previews/ }).click();
      await settings.getByLabel('Managed worktree location').fill(configuredWorktreeRoot);
      await settings.getByRole('button', { name: /Save settings/ }).click();
      await expect(settings).toBeHidden();
    });

    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Agent/ })
      .click();

    const agentNode = page.getByRole('article', { name: 'Agent: Agent' });
    await expect(agentNode).toBeVisible();
    await agentNode.click();
    const runConfiguration = page.getByRole('region', {
      name: 'Agent run settings',
    });
    await expect(runConfiguration.getByText('Approval required')).toBeVisible();
    await runConfiguration.getByLabel('Agent to run').selectOption('test-agent');
    await runConfiguration.getByLabel('Permission profile').selectOption('worktree-write');
    const writablePrompt = 'Create the deterministic local proof file after approval.';
    await runConfiguration.getByLabel('Prompt').fill(writablePrompt);

    await test.step('preflight reveals the exact launch and cancellation starts no process', async () => {
      await runConfiguration.getByRole('button', { name: /Review & run/ }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Review this run before it starts',
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("This run is ready. The agent won't start until you approve it."),
      ).toBeVisible();
      await expect(
        dialog.getByText('Local deterministic test process', { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText('PIPES', { exact: true })).toBeVisible();
      await expect(dialog).toContainText(/packages[\\/]+test-agent[\\/]+dist[\\/]+cli\.js/);
      await expect(dialog).toContainText(writablePrompt);
      await expect(dialog).toContainText('Test agent in a dedicated worktree');
      await expect(dialog).toContainText('Network: provider-controlled');
      // The configured root has a deliberately unique leaf. Forgeboard canonicalizes paths, so
      // Windows may expand the runner's 8.3 short temp prefix before displaying it.
      await expect(dialog).toContainText('ui-configured-worktrees');

      await dialog.getByRole('button', { name: 'Cancel run' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Cancelled the run before it started.')).toBeVisible();
      await expect(page.locator('.run-history')).not.toContainText(
        'Forgeboard deterministic agent started.',
      );
    });

    await test.step('approval streams real output and reports the changed worktree file', async () => {
      await runConfiguration.getByRole('button', { name: /Review & run/ }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Review this run before it starts',
      });
      await expect(dialog).toBeVisible();
      await approveNextNativeAgentLaunch(session.app, dialog, 'test-agent', async () => {
        await dialog.getByRole('button', { name: 'Approve and start' }).click();
      });
      await expect(dialog).toBeHidden();

      const history = page.locator('.run-history');
      await expect(history).toContainText('Forgeboard deterministic agent started.', {
        timeout: 20_000,
      });
      await expect(history).toContainText('succeeded · 1 changed file', {
        timeout: 20_000,
      });
      await expect(page.locator('.event-stream')).toContainText(
        'Agent wrote forgeboard-agent-output-',
      );
      await expect(agentNode.locator('.node-status-label')).toContainText('succeeded');
    });

    await test.step('the same local agent can complete a read-only plan with no changes', async () => {
      await runConfiguration.getByLabel('Permission profile').selectOption('plan-read-only');
      await runConfiguration
        .getByLabel('Prompt')
        .fill('Produce the deterministic read-only plan without writing files.');
      await runConfiguration.getByRole('button', { name: /Review & run/ }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Review this run before it starts',
      });
      await expect(dialog).toContainText('Test agent read-only plan');
      await expect(dialog).toContainText('Write: none');
      await expect(dialog).toContainText('Network: provider-controlled');
      await approveNextNativeAgentLaunch(session.app, dialog, 'test-agent', async () => {
        await dialog.getByRole('button', { name: 'Approve and start' }).click();
      });

      const history = page.locator('.run-history');
      await expect(history).toContainText('Read-only plan completed without filesystem writes.', {
        timeout: 20_000,
      });
      await expect(history).toContainText('succeeded · no file changes', {
        timeout: 20_000,
      });
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
