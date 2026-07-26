import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';
import {
  expectCancelDefaultDialog,
  installCollaborationDialogHarness,
  queueCollaborationDialog,
  waitForCollaborationDialog,
} from './native-dialogs.js';
import { startCollaborationServer, type CollaborationServerFixture } from './server-fixture.js';

test('local direct collaboration refuses to create internet-shareable invite links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-collaboration-invites-e2e-'));
  const externalRequests: string[] = [];
  let server: CollaborationServerFixture | null = null;
  let electronApp: ElectronApplication | null = null;

  try {
    server = await startCollaborationServer();
    const owner = await launchDesktop(join(root, 'owner-user-data'));
    electronApp = owner.app;
    watchExternalRequests(owner.page, externalRequests);
    await owner.page.getByRole('button', { name: 'Use safe defaults' }).click();
    await installCollaborationDialogHarness(owner.app);

    const settings = await openConnectivitySettings(owner.page);
    await settings.getByText('Server and advanced options').click();
    await settings.getByRole('checkbox', { name: /Enable collaboration/u }).check();
    await settings.getByLabel('Collaboration server URL').fill(server.webSocketUrl);
    await settings
      .getByRole('textbox', { name: /Collaboration management API URL/u })
      .fill(server.httpUrl);
    await settings.getByLabel('Collaboration display name').fill('Owner E2E');
    await settings.getByLabel('Collaborator ID').fill('owner-e2e');
    await settings.getByLabel('Collaboration room').fill('invite-e2e-room');
    await settings
      .locator('input[name="collaboration-access-token"]')
      .fill(server.ownerAccessToken);

    const dialogIndex = await queueCollaborationDialog(owner.app, 1);
    await settings.getByRole('button', { name: 'Connect with access token' }).click();
    const dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
    expectCancelDefaultDialog(dialog, {
      title: 'Connect to collaboration server?',
      confirmLabel: 'Connect',
      secrets: [server.ownerAccessToken],
    });
    await expect(collaborationStatus(settings)).toContainText('Your role is owner', {
      timeout: 20_000,
    });

    const policyMessage =
      'Shared invites require a public wss:// WebSocket address and https:// management address.';
    await expect(settings.getByText(new RegExp(policyMessage, 'u'))).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Create invite' })).toBeDisabled();
    await expect(
      settings.getByRole('button', { name: 'Create & copy 10-minute invite' }),
    ).toBeDisabled();
    await expect(settings.getByRole('button', { name: 'Refresh invites' })).toBeEnabled();

    await settings.getByRole('button', { name: /Save settings/u }).click();
    await expect(settings).toBeHidden();
    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await server?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function openConnectivitySettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: 'Connectivity', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'Collaboration' })).toBeVisible();
  return settings;
}

async function configureIdentity(
  settings: Locator,
  server: CollaborationServerFixture,
  identity: { displayName: string; subject: string },
): Promise<void> {
  await settings.getByText('Advanced', { exact: true }).click();
  await settings.getByRole('checkbox', { name: /Enable collaboration/u }).check();
  await settings.getByLabel('Collaboration server URL').fill(server.webSocketUrl);
  await settings
    .getByRole('textbox', { name: /Collaboration management API URL/u })
    .fill(server.httpUrl);
  await settings.getByLabel('Collaboration display name').fill(identity.displayName);
  await settings.getByLabel('Collaborator ID').fill(identity.subject);
}

function sessionInvite(settings: Locator, role: 'reviewer' | 'viewer'): Locator {
  return settings
    .getByRole('list', { name: 'Room invite history' })
    .getByRole('listitem')
    .filter({ hasText: new RegExp(`^${role} \\u00b7`, 'u') });
}

function collaborationStatus(settings: Locator): Locator {
  return settings.locator('.recovery-guidance[role="status"]');
}
