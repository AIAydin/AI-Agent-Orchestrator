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
import {
  startEmptyCollaborationServer,
  type EmptyCollaborationServerFixture,
} from './server-fixture.js';

test('room creation, owner administration, audit, and renewal work through the UI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-room-management-e2e-'));
  const externalRequests: string[] = [];
  let server: EmptyCollaborationServerFixture | null = null;
  let electronApp: ElectronApplication | null = null;

  try {
    server = await startEmptyCollaborationServer();
    const owner = await launchDesktop(join(root, 'owner-user-data'));
    electronApp = owner.app;
    watchExternalRequests(owner.page, externalRequests);
    await owner.page.getByRole('button', { name: 'Use safe defaults' }).click();
    await installCollaborationDialogHarness(owner.app);
    const settings = await openConnectivitySettings(owner.page);
    await configureIdentity(settings, server);
    await settings.getByLabel('Collaboration room').fill('management-e2e-room');
    await settings.getByText('My server requires an admin token').click();

    const adminToken = settings.getByLabel(/^Server administrator token/u);
    await adminToken.fill(server.adminToken);
    let dialogIndex = await queueCollaborationDialog(owner.app, 1);
    await settings.getByRole('button', { name: 'Create room and connect' }).click();
    let dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
    expectCancelDefaultDialog(dialog, {
      title: 'Create collaboration room?',
      confirmLabel: 'Create and connect',
      secrets: [server.adminToken],
    });
    await expect(collaborationStatus(settings)).toContainText('Your role is owner', {
      timeout: 20_000,
    });
    await expect(settings.getByRole('heading', { name: 'Room administration' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Create invite' })).toBeDisabled();

    dialogIndex = await queueCollaborationDialog(owner.app, 1);
    await settings.getByRole('button', { name: 'Refresh room members' }).click();
    dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
    expectCancelDefaultDialog(dialog, {
      title: 'Load collaboration members?',
      confirmLabel: 'Load members',
      secrets: [server.adminToken],
    });
    await expect(settings.getByText('Owner E2E (owner-e2e)', { exact: true })).toBeVisible();

    dialogIndex = await queueCollaborationDialog(owner.app, 1);
    await settings.getByRole('button', { name: 'Refresh room audit' }).click();
    dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
    expectCancelDefaultDialog(dialog, {
      title: 'Load collaboration audit history?',
      confirmLabel: 'Load audit history',
      secrets: [server.adminToken],
    });
    await expect(
      settings.getByRole('list', { name: 'Room audit events' }).getByText(/room.created/u),
    ).toBeVisible();

    dialogIndex = await queueCollaborationDialog(owner.app, 1);
    await settings.getByRole('button', { name: 'Renew owner session' }).click();
    dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
    expectCancelDefaultDialog(dialog, {
      title: 'Renew owner session?',
      confirmLabel: 'Renew session',
      secrets: [server.adminToken],
    });
    await expect(collaborationStatus(settings)).toContainText('Renewed the owner session');

    await server.stop();
    server = null;
    await expect(collaborationStatus(settings)).toContainText('Reconnecting to the approved room', {
      timeout: 20_000,
    });
    await settings.getByRole('button', { name: /Save settings/u }).click();
    await expect(settings).toBeHidden();
    await owner.page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(owner.page.locator('.project-switcher')).toContainText('artemis-demo');
    await owner.page
      .locator('.template-section')
      .getByRole('button', { name: /Product brief/u })
      .click();
    await expect(owner.page.getByRole('article', { name: /^Product brief: /u })).toBeVisible();
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
  return settings;
}

async function configureIdentity(
  settings: Locator,
  server: EmptyCollaborationServerFixture,
): Promise<void> {
  await settings.getByText('Advanced', { exact: true }).click();
  await settings.getByRole('checkbox', { name: /Enable collaboration/u }).check();
  await settings.getByLabel('Collaboration server URL').fill(server.webSocketUrl);
  await settings
    .getByRole('textbox', { name: /Collaboration management API URL/u })
    .fill(server.httpUrl);
  await settings.getByLabel('Collaboration display name').fill('Owner E2E');
  await settings.getByLabel('Collaborator ID').fill('owner-e2e');
}

function collaborationStatus(settings: Locator): Locator {
  return settings.locator('.recovery-guidance[role="status"]');
}
