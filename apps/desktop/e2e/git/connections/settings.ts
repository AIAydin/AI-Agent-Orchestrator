import { expect, type Locator, type Page } from '@playwright/test';

/** The GitHub CLI card now lives on the Agents & runtime settings page. */
export async function openGitHubCliSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Agents & runtime/ }).click();
  await expect(settings.getByRole('heading', { name: 'GitHub CLI' })).toBeVisible();
  return settings;
}
