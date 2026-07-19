import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';

import {
  approveNextNativeAgentLaunch,
  launchDesktop,
  watchExternalRequests,
} from './support/electron.js';

test('a UI-configured Custom host profile persists and governs deterministic runs', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-custom-permission-e2e-'));
  const configuredWorktreeRoot = join(
    await realpath(userDataDirectory),
    'custom-profile-worktrees',
  );
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let activeElectronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();

    await test.step('the complete host policy is configured and saved without editing files', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');

      await settings.getByRole('button', { name: /Git & previews/ }).click();
      await settings.getByLabel('Managed worktree location').fill(configuredWorktreeRoot);

      await settings.getByRole('button', { name: 'Permissions', exact: true }).click();
      await settings.getByLabel('Default permission profile').selectOption('custom');
      await settings.getByLabel('Where the agent runs').selectOption('host');
      await settings.getByLabel('File access').selectOption('assigned-worktree-read-only');
      await settings.getByLabel('Ignored files').selectOption('deny');
      await settings.getByLabel('Sensitive files').selectOption('deny');
      await settings.getByLabel('Which programs can start it').selectOption('selected-agent-only');
      await settings.getByRole('checkbox', { name: /Ask the agent to allow tests/ }).check();

      await expect(
        settings.getByText('Limits are stated, not enforced', { exact: true }),
      ).toBeVisible();
      await expect(
        settings.getByText('Review before the main branch', { exact: true }),
      ).toBeVisible();
      await expect(
        settings.getByText('This computer is not a sandbox', { exact: true }),
      ).toBeVisible();
      await expect(settings.getByRole('button', { name: /Save settings/ })).toBeEnabled();
      await settings.getByRole('button', { name: /Save settings/ }).click();
      await expect(settings).toBeHidden();
    });

    await test.step('the exact Custom settings survive a full process restart', async () => {
      await electronApp?.close();
      electronApp = null;

      const secondSession = await launchDesktop(userDataDirectory);
      electronApp = secondSession.app;
      activeElectronApp = secondSession.app;
      page = secondSession.page;
      watchExternalRequests(page, externalRequests);

      await expect(page.locator('.setup-shell')).toHaveCount(0);
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await settings.getByRole('button', { name: 'Permissions', exact: true }).click();

      await expect(settings.getByLabel('Default permission profile')).toHaveValue('custom');
      await expect(settings.getByLabel('Where the agent runs')).toHaveValue('host');
      await expect(settings.getByLabel('File access')).toHaveValue('assigned-worktree-read-only');
      await expect(settings.getByLabel('Ignored files')).toHaveValue('deny');
      await expect(settings.getByLabel('Sensitive files')).toHaveValue('deny');
      await expect(settings.getByLabel('Which programs can start it')).toHaveValue(
        'selected-agent-only',
      );
      await expect(
        settings.getByRole('checkbox', {
          name: /Ask the agent to allow tests/,
        }),
      ).toBeChecked();
      await settings.getByRole('button', { name: 'Close settings' }).click();
    });

    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
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
    const permissionSelection = runConfiguration.getByLabel('Permission profile');

    await test.step('Custom is an ordinary selectable Agent-node profile', async () => {
      await expect(runConfiguration.getByLabel('Agent to run')).toHaveValue('test-agent');
      await expect(permissionSelection).toHaveValue('custom');
      await permissionSelection.selectOption('plan-read-only');
      await permissionSelection.selectOption('custom');
      await expect(
        runConfiguration.getByText('Custom · runs on this computer (not enforced)'),
      ).toBeVisible();
      await expect(runConfiguration.getByText('Assigned worktree · read-only')).toBeVisible();
      await expect(runConfiguration).toContainText(
        'Ignored files not allowed · sensitive files not allowed · dev servers not allowed · tests allowed',
      );
    });

    const readOnlyPrompt = 'Produce a deterministic plan under the saved Custom host policy.';
    await runConfiguration.getByLabel('Prompt').fill(readOnlyPrompt);

    await test.step('exact approval discloses the full Custom policy and cancel starts no agent', async () => {
      await runConfiguration.getByRole('button', { name: 'Review and run Agent' }).click();
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
      await expect(dialog).toContainText('custom-profile-worktrees');
      await expect(dialog.getByText(readOnlyPrompt, { exact: true })).toBeVisible();
      await expect(dialog).toContainText('Attached context');
      await expect(dialog).toContainText('None');
      await expect(dialog).toContainText('No context record');

      await assertReadOnlyCustomDisclosure(dialog);

      await dialog.getByRole('button', { name: 'Cancel run' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Cancelled the run before it started.')).toBeVisible();
      const cancelledAttempt = page.getByRole('article', {
        name: 'Initial run attempt Terminated',
      });
      await expect(cancelledAttempt).toContainText('DurationNot started');
      await expect(cancelledAttempt).toContainText('WorktreeCleaned');
      await expect(cancelledAttempt).not.toContainText('Forgeboard deterministic agent started.');
      await expect(agentNode.locator('.node-status-label')).toContainText('cancelled');
    });

    await test.step('approval honors the configured read-only behavior', async () => {
      await runConfiguration.getByRole('button', { name: 'Review and run Agent' }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Review this run before it starts',
      });
      await assertReadOnlyCustomDisclosure(dialog);
      await approveNextNativeAgentLaunch(activeElectronApp, dialog, 'test-agent', async () => {
        await dialog.getByRole('button', { name: 'Approve and start' }).click();
      });

      const attempt = page.getByRole('article', { name: 'Initial run attempt Succeeded' }).first();
      await expect(attempt).toContainText('Forgeboard deterministic agent started.', {
        timeout: 20_000,
      });
      await expect(attempt).toContainText('Read-only plan completed without filesystem writes.', {
        timeout: 20_000,
      });
      await expect(attempt).toContainText('Files0');
      await expect(page.locator('.event-stream')).not.toContainText('Agent wrote');
    });

    await test.step('a UI change to read/write is disclosed and permits one reviewed write', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await settings.getByRole('button', { name: 'Permissions', exact: true }).click();
      await settings.getByLabel('File access').selectOption('assigned-worktree-write');
      await settings.getByRole('button', { name: /Save settings/ }).click();
      await expect(settings).toBeHidden();

      await expect(runConfiguration.getByText('Assigned worktree · read and write')).toBeVisible();
      const writePrompt =
        'Create the deterministic proof file under the saved Custom write policy.';
      await runConfiguration.getByLabel('Prompt').fill(writePrompt);
      await runConfiguration.getByRole('button', { name: 'Review and run Agent' }).click();

      const dialog = page.getByRole('dialog', {
        name: 'Review this run before it starts',
      });
      await expect(dialog.getByText(writePrompt, { exact: true })).toBeVisible();
      const permission = dialog.getByRole('region', {
        name: 'What this agent can do',
      });
      await expect(permission).toContainText('Custom host (read/write) · custom · disclosure-only');
      await expect(permission).toContainText('Assigned worktree · read and write');
      await expect(permission).toContainText('Write:');
      await expect(permission).not.toContainText('Write: none');
      await expect(permission).toContainText('Network: provider-controlled');
      await approveNextNativeAgentLaunch(activeElectronApp, dialog, 'test-agent', async () => {
        await dialog.getByRole('button', { name: 'Approve and start' }).click();
      });

      const attempt = page.getByRole('article', { name: 'Initial run attempt Succeeded' }).first();
      await expect(attempt).toContainText('Forgeboard deterministic agent started.', {
        timeout: 20_000,
      });
      await expect(attempt).toContainText('Files1');
      await expect(page.locator('.event-stream')).toContainText(
        'Agent wrote forgeboard-agent-output-',
      );
      await expect(agentNode.locator('.node-status-label')).toContainText('succeeded');
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function assertReadOnlyCustomDisclosure(dialog: Locator): Promise<void> {
  const permission = dialog.getByRole('region', {
    name: 'What this agent can do',
  });
  await expect(permission).toContainText(
    'Custom host (read-only intent) · custom · disclosure-only',
  );
  await expect(permission).toContainText('Write: none');
  await expect(permission).toContainText('Network: provider-controlled');
  await expect(permission).toContainText('On this computer (limits stated, not enforced)');
  await expect(permission).toContainText('Assigned worktree · read-only');
  await expect(permission).toContainText('Ignored files not allowed · sensitive files not allowed');
  await expect(permission).toContainText("Only the selected agent's program");
  await expect(permission).toContainText(
    'Dev servers not allowed · tests allowed · requested, not enforced',
  );
  await expect(permission).toContainText('Review always required');
  await expect(permission).toContainText(
    'The working folder and the read and write folder lists are rules Forgeboard states to the agent, not limits your computer enforces.',
  );
  await expect(permission).toContainText(
    'Network access stays controlled by the provider you chose and by this computer.',
  );
  await expect(permission).toContainText(
    'Rules about ignored or sensitive files, and about actions Forgeboard manages, are instructions to the agent; they do not limit other programs the agent starts.',
  );
  await expect(permission).toContainText(
    'Allowing the agent to see sensitive or ignored files never shares a file on its own; you still approve each file shared as context.',
  );
  await expect(permission).toContainText(
    'The launch allowlist applies only to the exact program Forgeboard starts, not to anything that program starts.',
  );
}
