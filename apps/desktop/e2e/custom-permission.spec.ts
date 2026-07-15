import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from './electron.js';

test('a UI-configured Custom host profile persists and governs deterministic runs', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-custom-permission-e2e-'));
  const configuredWorktreeRoot = join(userDataDirectory, 'custom-profile-worktrees');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
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
      await settings.getByLabel('Runtime boundary').selectOption('host');
      await settings.getByLabel('Filesystem policy').selectOption('assigned-worktree-read-only');
      await settings.getByLabel('Ignored files').selectOption('deny');
      await settings.getByLabel('Sensitive files').selectOption('deny');
      await settings.getByLabel('Top-level launch policy').selectOption('selected-agent-only');
      await settings.getByRole('checkbox', { name: /Ask the agent to allow tests/ }).check();

      await expect(
        settings.getByText('Host policy is disclosure-only', { exact: true }),
      ).toBeVisible();
      await expect(
        settings.getByText('Review before the primary branch', { exact: true }),
      ).toBeVisible();
      await expect(settings.getByText('Host cwd is not a sandbox', { exact: true })).toBeVisible();
      await expect(settings.getByRole('button', { name: /Save settings/ })).toBeEnabled();
      await settings.getByRole('button', { name: /Save settings/ }).click();
      await expect(settings).toBeHidden();
    });

    await test.step('the exact Custom settings survive a full process restart', async () => {
      await electronApp?.close();
      electronApp = null;

      const secondSession = await launchDesktop(userDataDirectory);
      electronApp = secondSession.app;
      page = secondSession.page;
      watchExternalRequests(page, externalRequests);

      await expect(page.locator('.setup-shell')).toHaveCount(0);
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await settings.getByRole('button', { name: 'Permissions', exact: true }).click();

      await expect(settings.getByLabel('Default permission profile')).toHaveValue('custom');
      await expect(settings.getByLabel('Runtime boundary')).toHaveValue('host');
      await expect(settings.getByLabel('Filesystem policy')).toHaveValue(
        'assigned-worktree-read-only',
      );
      await expect(settings.getByLabel('Ignored files')).toHaveValue('deny');
      await expect(settings.getByLabel('Sensitive files')).toHaveValue('deny');
      await expect(settings.getByLabel('Top-level launch policy')).toHaveValue(
        'selected-agent-only',
      );
      await expect(
        settings.getByRole('checkbox', { name: /Ask the agent to allow tests/ }),
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
    const runConfiguration = page.getByRole('region', { name: 'Agent run configuration' });
    const permissionSelection = runConfiguration.getByLabel('Permission profile');

    await test.step('Custom is an ordinary selectable Agent-node profile', async () => {
      await expect(runConfiguration.getByLabel('Installed adapter')).toHaveValue('test-agent');
      await expect(permissionSelection).toHaveValue('custom');
      await permissionSelection.selectOption('plan-read-only');
      await permissionSelection.selectOption('custom');
      await expect(runConfiguration.getByText('Custom · host disclosure-only')).toBeVisible();
      await expect(
        runConfiguration.getByText('Assigned worktree · declared read-only'),
      ).toBeVisible();
      await expect(runConfiguration).toContainText(
        'Ignored deny · sensitive deny · dev servers deny · tests allow',
      );
    });

    const readOnlyPrompt = 'Produce a deterministic plan under the saved Custom host policy.';
    await runConfiguration.getByLabel('Prompt').fill(readOnlyPrompt);

    await test.step('exact approval discloses the full Custom policy and cancel starts no agent', async () => {
      await runConfiguration.getByRole('button', { name: /Review & run/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Review the exact agent launch' });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText(
          'Forgeboard has prepared this run, but no approved agent run has started.',
        ),
      ).toBeVisible();
      await expect(
        dialog.getByText('Local deterministic test process', { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText('PIPES', { exact: true })).toBeVisible();
      await expect(dialog).toContainText(/packages[\\/]+test-agent[\\/]+dist[\\/]+cli\.js/);
      await expect(dialog).toContainText('custom-profile-worktrees');
      await expect(dialog.getByText(readOnlyPrompt, { exact: true })).toBeVisible();
      await expect(dialog).toContainText('Context attachments');
      await expect(dialog).toContainText('None');
      await expect(dialog).toContainText('No context manifest');

      await assertReadOnlyCustomDisclosure(dialog);

      await dialog.getByRole('button', { name: 'Cancel before launch' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Cancelled the prepared run before launch.')).toBeVisible();
      await expect(page.locator('.run-history')).toContainText(
        'No runs yet. Forgeboard never fabricates agent output.',
      );
      await expect(page.locator('.run-history')).not.toContainText(
        'Forgeboard deterministic agent started.',
      );
      await expect(agentNode.locator('.node-status-label')).toContainText('cancelled');
    });

    await test.step('approval honors the configured read-only behavior', async () => {
      await runConfiguration.getByRole('button', { name: /Review & run/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Review the exact agent launch' });
      await assertReadOnlyCustomDisclosure(dialog);
      await dialog.getByRole('button', { name: 'Approve & launch' }).click();

      const history = page.locator('.run-history');
      await expect(history).toContainText('Forgeboard deterministic agent started.', {
        timeout: 20_000,
      });
      await expect(history).toContainText('Read-only plan completed without filesystem writes.', {
        timeout: 20_000,
      });
      await expect(history).toContainText('succeeded · no file changes', { timeout: 20_000 });
      await expect(page.locator('.event-stream')).not.toContainText('Agent wrote');
    });

    await test.step('a UI change to read/write is disclosed and permits one reviewed write', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await settings.getByRole('button', { name: 'Permissions', exact: true }).click();
      await settings.getByLabel('Filesystem policy').selectOption('assigned-worktree-write');
      await settings.getByRole('button', { name: /Save settings/ }).click();
      await expect(settings).toBeHidden();

      await expect(runConfiguration.getByText('Assigned worktree · read and write')).toBeVisible();
      const writePrompt =
        'Create the deterministic proof file under the saved Custom write policy.';
      await runConfiguration.getByLabel('Prompt').fill(writePrompt);
      await runConfiguration.getByRole('button', { name: /Review & run/ }).click();

      const dialog = page.getByRole('dialog', { name: 'Review the exact agent launch' });
      await expect(dialog.getByText(writePrompt, { exact: true })).toBeVisible();
      const permission = dialog.getByRole('region', { name: 'Effective permission profile' });
      await expect(permission).toContainText('Custom host (read/write) · custom · disclosure-only');
      await expect(permission).toContainText('Assigned worktree · read and write');
      await expect(permission).toContainText('Write:');
      await expect(permission).not.toContainText('Write: none');
      await expect(permission).toContainText('Network: provider-controlled');
      await dialog.getByRole('button', { name: 'Approve & launch' }).click();

      const history = page.locator('.run-history');
      await expect(history).toContainText('Forgeboard deterministic agent started.', {
        timeout: 20_000,
      });
      await expect(history).toContainText('succeeded · 1 changed file', { timeout: 20_000 });
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
  const permission = dialog.getByRole('region', { name: 'Effective permission profile' });
  await expect(permission).toContainText(
    'Custom host (read-only intent) · custom · disclosure-only',
  );
  await expect(permission).toContainText('Write: none');
  await expect(permission).toContainText('Network: provider-controlled');
  await expect(permission).toContainText('Host disclosure-only policy');
  await expect(permission).toContainText('Assigned worktree · declared read-only');
  await expect(permission).toContainText('Ignored deny · sensitive deny');
  await expect(permission).toContainText('Selected agent only');
  await expect(permission).toContainText('Dev servers deny · tests allow · advisory');
  await expect(permission).toContainText('Review always required');
  await expect(permission).toContainText(
    'Host cwd and root lists are disclosure policy, not an operating-system filesystem sandbox.',
  );
  await expect(permission).toContainText(
    'Host networking remains controlled by the selected provider and operating system.',
  );
  await expect(permission).toContainText(
    'Ignored/sensitive visibility and Forgeboard-managed action rules are explicit agent instructions; they do not constrain subprocesses spawned by the agent.',
  );
  await expect(permission).toContainText(
    'Allowing sensitive or ignored visibility never attaches a file automatically and never replaces exact per-file context approval.',
  );
  await expect(permission).toContainText(
    'The launch allowlist applies only to the exact top-level executable started by Forgeboard, not its descendants.',
  );
}
