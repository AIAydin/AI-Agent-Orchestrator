import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import {
  continuePlanWithNativeResponse,
  nativeDialogText,
  selectNextNativePath,
  type NativeDialogRecord,
} from './native-dialogs.js';

export async function openGitConnectionsSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  await expect(settings.getByRole('heading', { name: 'Git connections' })).toBeVisible();
  return settings;
}

export async function configureNetworkRemoteThroughUi(input: {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly name: string;
  readonly url: string;
}): Promise<NativeDialogRecord> {
  const settings = await openGitConnectionsSettings(input.page);
  await settings.getByLabel('Remote name').fill(input.name);
  await settings.getByLabel('Remote URL').fill(input.url);
  await settings.getByRole('button', { name: 'Add remote' }).click();
  const plan = input.page.getByRole('alertdialog', { name: 'Review remote addition' });
  await expect(plan).toContainText('No internet access needed');
  const record = await continuePlanWithNativeResponse({
    app: input.app,
    plan,
    response: 1,
    title: 'Add Git remote?',
    buttons: ['Cancel', 'Add remote'],
  });
  await expect(settings.getByRole('button', { name: `Remove ${input.name}` })).toBeVisible();
  await settings.getByRole('button', { name: 'Close settings' }).click();
  return record;
}

export async function configureCustomGitHubCliThroughUi(input: {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly executablePath: string;
  readonly executableFileName: string;
}): Promise<NativeDialogRecord> {
  const settings = await openGitConnectionsSettings(input.page);
  await selectNextNativePath(input.app, input.executablePath);
  await settings.getByRole('button', { name: 'Choose GitHub CLI file' }).click();
  const plan = input.page.getByRole('alertdialog', { name: 'GitHub CLI setup' });
  await expect(plan).toContainText(input.executableFileName);
  await expect(plan).not.toContainText(input.executablePath);
  const record = await continuePlanWithNativeResponse({
    app: input.app,
    plan,
    response: 1,
    title: 'Change GitHub CLI setup?',
    buttons: ['Cancel', 'Use selected GitHub CLI'],
  });
  expect(nativeDialogText(record)).toContain(input.executablePath);
  expect(nativeDialogText(record)).toContain(`${input.executablePath} --version`);
  await expect(settings.getByText('GitHub CLI ready')).toBeVisible();
  await settings.getByRole('button', { name: 'Close settings' }).click();
  return record;
}
