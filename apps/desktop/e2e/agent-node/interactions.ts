import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import { approveNextNativeAgentLaunch } from '../support/electron.js';
import { ADAPTER_ID, MODEL_ID } from './fixture.js';
import { approveExtensionInstall, choosePath } from './native-confirmation.js';

export async function configureThroughUi(
  app: ElectronApplication,
  page: Page,
  extensionPath: string,
  worktreeRoot: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Use safe defaults' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  await settings.getByLabel('Managed worktree location').fill(worktreeRoot);
  await settings.getByRole('button', { name: 'Extensions', exact: true }).click();
  await choosePath(app, extensionPath);
  await settings.getByRole('button', { name: 'Choose extension folder' }).click();
  const review = page.getByRole('dialog', { name: 'Review extension install' });
  await expect(review).toContainText(ADAPTER_ID);
  await expect(review).toContainText('agent.adapter.register');
  await expect(review).toContainText('agent.process.launch');
  await approveExtensionInstall(app, review);
  await expect(review).toBeHidden();
  await expect(settings).toContainText('Trusted · active');
  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
}

export async function openRepository(
  app: ElectronApplication,
  page: Page,
  repositoryPath: string,
): Promise<void> {
  await choosePath(app, repositoryPath);
  await page.getByRole('button', { name: /Open a project folder/i }).click();
  await expect(page.locator('.project-switcher')).toContainText('primary-repository');
}

export async function addAndConfigureAgent(page: Page, prompt: string): Promise<Locator> {
  await page
    .locator('.template-section')
    .getByRole('button', { name: /^Agent/ })
    .click();
  const node = page.getByRole('article', { name: /^Agent: /u });
  await node.click();
  const configuration = page.getByRole('region', { name: 'Agent run settings' });
  await configuration.getByLabel('Agent to run').selectOption(ADAPTER_ID);
  await configuration.getByLabel('Model (optional)').fill(MODEL_ID);
  await configuration.getByLabel('Permission profile').selectOption('worktree-write');
  await configuration.getByLabel('Prompt').fill(prompt);
  return configuration;
}

export async function approvePreparedRun(
  app: ElectronApplication,
  page: Page,
  openReview: () => Promise<unknown>,
  expectedText: readonly string[],
): Promise<Locator> {
  await openReview();
  const dialog = page.getByRole('dialog', { name: 'Review this run before it starts' });
  try {
    await expect(dialog).toBeVisible();
  } catch (error) {
    const alerts = await page.getByRole('alert').allTextContents();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Visible alerts: ${alerts.join(' | ')}`,
      { cause: error },
    );
  }
  for (const text of expectedText) await expect(dialog).toContainText(text);
  await expect(page.locator('.autosave-state')).toHaveText('Saved locally');
  try {
    await approveNextNativeAgentLaunch(
      app,
      dialog,
      ADAPTER_ID,
      async () => {
        await dialog.getByRole('button', { name: 'Approve and start' }).click();
      },
      { pollTimeoutMs: 20_000 },
    );
  } catch (error) {
    const alerts = await page.getByRole('alert').allTextContents();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Visible alerts: ${alerts.join(' | ')}`,
      { cause: error },
    );
  }
  await expect(dialog).toBeHidden();
  return dialog;
}
