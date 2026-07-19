import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from './support/electron.js';

test('first-run CLI readiness is remediated and completed entirely in the UI', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-readiness-e2e-'));
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);
    const executable = await electronApp.evaluate(() => process.execPath);
    const missingExecutable = join(userDataDirectory, 'missing-custom-agent');

    const setup = page.getByRole('dialog');
    await expect(setup).toHaveAccessibleName('Ready to build without wiring config files?');
    await setup.getByRole('button', { name: /Set up Forgeboard/ }).click();
    const customCli = setup.getByRole('radio', { name: /Custom agent/ });
    await setup.getByText('Custom agent', { exact: true }).click();
    await expect(customCli).toBeChecked();

    const executableField = setup.getByLabel(/^Executable\b/);
    await executableField.fill(missingExecutable);
    const refresh = setup.getByRole('button', {
      name: /Check Custom agent again/,
    });
    await refresh.click();
    await expect(setup.getByText('Selected executable needs attention')).toBeVisible();
    await expect(setup.getByRole('button', { name: /Continue/ })).toBeDisabled();

    await electronApp.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        __forgeboardReadinessDialogCalls?: number;
      };
      state.__forgeboardReadinessDialogCalls = 0;
      Object.defineProperty(dialog, 'showMessageBox', {
        configurable: true,
        value: () => {
          state.__forgeboardReadinessDialogCalls =
            (state.__forgeboardReadinessDialogCalls ?? 0) + 1;
          return Promise.resolve({ response: 1, checkboxChecked: false });
        },
      });
    });
    await executableField.fill(executable);
    await refresh.click();
    await expect(setup.getByText('Selected executable is ready')).toBeVisible();
    await expect
      .poll(
        async () =>
          await electronApp?.evaluate(() => {
            const state = globalThis as typeof globalThis & {
              __forgeboardReadinessDialogCalls?: number;
            };
            return state.__forgeboardReadinessDialogCalls ?? 0;
          }),
      )
      .toBe(1);
    await expect(setup.getByRole('button', { name: /Continue/ })).toBeEnabled();
    await setup.getByRole('button', { name: /Continue/ }).click();

    const readOnlyProfile = setup.getByRole('radio', {
      name: /Plan \/ read-only/,
    });
    await setup.getByText('Plan / read-only', { exact: true }).click();
    await expect(readOnlyProfile).toBeChecked();
    await setup.getByRole('button', { name: /Continue/ }).click();
    const testCommandExecutable = setup.getByLabel('Test command executable');
    await testCommandExecutable.fill(missingExecutable);
    const setupTestCommand = setup.getByRole('group', { name: 'Test command' });
    await expect(setupTestCommand.getByRole('alert')).toContainText(
      /configured check executable .* was not found/u,
    );
    await expect(setup.getByRole('button', { name: /Continue/ })).toBeDisabled();
    await expect(setupTestCommand.getByRole('alert')).toContainText(
      /Use Browse to select the executable/u,
    );

    await testCommandExecutable.fill(executable);
    await setup
      .getByLabel('Test command arguments, one argument per line; blank lines are ignored')
      .fill('-e\nprocess.stdout.write("READY")');
    await expect(setup.getByText(/Executable ready; the command was not run/u)).toBeVisible();
    await setup.getByRole('button', { name: /Continue/ }).click();
    await expect(setup.getByText('Your local workshop is ready')).toBeVisible();
    await expect(setup).toContainText('Custom agent');
    const tour = setup.getByRole('region', { name: 'Getting started tour' });
    await expect(tour.getByRole('tab')).toHaveCount(4);
    await tour.getByRole('tab', { name: /Get help and control your data/u }).click();
    await expect(tour).toContainText('Settings → Data & privacy');
    await expect(tour).toContainText('built-in guides');
    await setup.getByRole('button', { name: /Open Forgeboard/ }).click();

    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-modal');
    await settings.getByRole('button', { name: /Agents & runtime/ }).click();
    await expect(settings.getByLabel('Default agent')).toHaveValue('custom');
    await expect(settings.getByLabel('Program file', { exact: true })).toHaveValue(executable);
    await settings.getByRole('button', { name: 'Checks', exact: true }).click();
    const tests = settings.getByRole('group', { name: 'Tests command' });
    await expect(tests.getByLabel('Executable')).toHaveValue(executable);
    await expect(tests.getByLabel('Arguments')).toHaveValue('-e\nprocess.stdout.write("READY")');
    await settings.getByRole('button', { name: 'Help & shortcuts' }).click();
    await settings.getByText('Replay Getting started tour').click();
    await expect(settings.getByRole('region', { name: 'Getting started tour' })).toBeVisible();
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
