import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type * as Electron from 'electron';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';
import {
  expectCancelDefaultDialog,
  installCollaborationDialogHarness,
  queueCollaborationDialog,
  waitForCollaborationDialog,
} from './native-dialogs.js';
import { startCollaborationServer, type CollaborationServerFixture } from './server-fixture.js';

test('owners manage token-free invite rows and a second profile redeems through the real server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-collaboration-invites-e2e-'));
  const ownerData = join(root, 'owner-user-data');
  const viewerData = join(root, 'viewer-user-data');
  const externalRequests: string[] = [];
  let server: CollaborationServerFixture | null = null;
  let electronApp: ElectronApplication | null = null;
  let priorClipboard: string | null = null;

  try {
    server = await startCollaborationServer();
    const owner = await launchDesktop(ownerData);
    electronApp = owner.app;
    priorClipboard = await owner.app.evaluate(({ clipboard }) => clipboard.readText());
    watchExternalRequests(owner.page, externalRequests);
    await useSafeDefaults(owner.page);
    await installCollaborationDialogHarness(owner.app);
    const ownerSettings = await openConnectivitySettings(owner.page);
    await configureIdentity(ownerSettings, server, {
      displayName: 'Owner E2E',
      subject: 'owner-e2e',
    });
    await ownerSettings.getByLabel('Collaboration room').fill('invite-e2e-room');
    await ownerSettings
      .locator('input[name="collaboration-access-token"]')
      .fill(server.ownerAccessToken);

    await test.step('the owner direct-joins through an exact cancel-default disclosure', async () => {
      const dialogIndex = await queueCollaborationDialog(owner.app, 1);
      const connect = ownerSettings.getByRole('button', {
        name: 'Connect with access token',
      });
      await expect(connect).toBeEnabled();
      await connect.click();
      let dialog;
      try {
        dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      } catch (error) {
        throw new Error(
          `The collaboration dialog did not open. Status: ${await collaborationStatus(ownerSettings).innerText()}`,
          { cause: error },
        );
      }
      expectCancelDefaultDialog(dialog, {
        title: 'Connect to collaboration server?',
        confirmLabel: 'Connect',
        secrets: [server!.ownerAccessToken],
      });
      expect(dialog.detail).toContain(`Address: ${server!.webSocketUrl}`);
      expect(dialog.detail).toContain('Item: invite-e2e-room');
      await expect(collaborationStatus(ownerSettings)).toContainText('Your role is owner', {
        timeout: 20_000,
      });
      await expect(ownerSettings.locator('input[name="collaboration-access-token"]')).toHaveCount(
        0,
      );
      await expectSecretsAbsent(owner.page, [server!.ownerAccessToken]);
    });

    await test.step('cancelled and approved creation expose only safe invite metadata', async () => {
      const create = ownerSettings.getByRole('button', {
        name: 'Create invite',
      });
      let dialogIndex = await queueCollaborationDialog(owner.app, 0);
      await create.click();
      let dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Create collaboration invite?',
        confirmLabel: 'Create invite',
      });
      await expect(collaborationStatus(ownerSettings)).toContainText(
        'Invite creation was cancelled',
      );
      await expect(
        ownerSettings.getByText('Invite history has not been loaded. Refresh to review this room.'),
      ).toBeVisible();

      await ownerSettings.getByLabel('Invite role').selectOption('viewer');
      await ownerSettings.getByLabel('Invite expires after').selectOption('900');
      await ownerSettings.getByLabel('Maximum uses').fill('1');
      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await create.click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Create collaboration invite?',
        confirmLabel: 'Create invite',
      });
      expect(dialog.detail).toContain('Role: viewer');
      expect(dialog.detail).toContain('Lifetime: 900 seconds');
      expect(dialog.detail).toContain('Maximum uses: 1');
      await ownerSettings.getByLabel('Invite role').selectOption('reviewer');
      await ownerSettings.getByLabel('Maximum uses').fill('2');
      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await create.click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Create collaboration invite?',
        confirmLabel: 'Create invite',
      });
      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Refresh invites' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Load collaboration invite history?',
        confirmLabel: 'Load invites',
      });
      await expect(sessionInvite(ownerSettings, 'viewer')).toBeVisible();
      await expect(sessionInvite(ownerSettings, 'reviewer')).toContainText('0 / 2 uses');
      await expect(
        ownerSettings.getByRole('list', { name: 'Room invite history' }).getByRole('listitem'),
      ).toHaveCount(2);
      await expectSecretsAbsent(owner.page, [server!.ownerAccessToken, '#token=']);
    });

    let inviteLink = '';
    let revokedInviteLink = '';
    await test.step('native copy leaves token-free UI and revoke removes its safe row', async () => {
      const viewerInvite = sessionInvite(ownerSettings, 'viewer');
      let dialogIndex = await queueCollaborationDialog(owner.app, 0);
      await viewerInvite.getByRole('button', { name: 'Copy' }).click();
      let dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Copy collaboration invite?',
        confirmLabel: 'Copy invite',
      });
      await expect(collaborationStatus(ownerSettings)).toContainText('Copy cancelled');
      expect(await owner.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        priorClipboard,
      );

      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await viewerInvite.getByRole('button', { name: 'Copy' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Copy collaboration invite?',
        confirmLabel: 'Copy invite',
      });
      await expect(collaborationStatus(ownerSettings)).toContainText('Invite link copied');
      inviteLink = await owner.app.evaluate(({ clipboard }) => clipboard.readText());
      expect(inviteLink).toMatch(/^forgeboard:\/\/collaboration\/invite\?\S+#token=\S+$/u);
      expect(new URL(inviteLink).searchParams.get('server')).toBe(server!.webSocketUrl);
      expect(new URL(inviteLink).searchParams.get('management')).toBe(`${server!.httpUrl}/`);
      const inviteToken = new URLSearchParams(new URL(inviteLink).hash.slice(1)).get('token');
      expect(inviteToken).not.toBeNull();
      await expectSecretsAbsent(owner.page, [inviteLink, inviteToken ?? '']);
      expect(JSON.stringify(dialog)).not.toContain(inviteLink);
      expect(JSON.stringify(dialog)).not.toContain(inviteToken);

      const reviewerInvite = sessionInvite(ownerSettings, 'reviewer');
      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await reviewerInvite.getByRole('button', { name: 'Copy' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Copy collaboration invite?',
        confirmLabel: 'Copy invite',
        secrets: [inviteLink, inviteToken ?? ''],
      });
      revokedInviteLink = await owner.app.evaluate(({ clipboard }) => clipboard.readText());
      expect(revokedInviteLink).toMatch(/^forgeboard:\/\/collaboration\/invite\?\S+#token=\S+$/u);
      const revokedToken =
        new URLSearchParams(new URL(revokedInviteLink).hash.slice(1)).get('token') ?? '';
      await expectSecretsAbsent(owner.page, [revokedInviteLink, revokedToken]);

      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await reviewerInvite.getByRole('button', { name: 'Revoke' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Revoke collaboration invite?',
        confirmLabel: 'Revoke invite',
        secrets: [inviteLink, inviteToken ?? '', revokedInviteLink, revokedToken],
      });
      await expect(collaborationStatus(ownerSettings)).toContainText('Invite revoked');
      await expect(sessionInvite(ownerSettings, 'reviewer')).toContainText('revoked');
      await expect(
        sessionInvite(ownerSettings, 'reviewer').getByRole('button', {
          name: 'Revoke',
        }),
      ).toHaveCount(0);
      await expect(sessionInvite(ownerSettings, 'viewer')).toBeVisible();
    });

    await restoreClipboard(owner.app, priorClipboard);
    await electronApp.close();
    electronApp = null;

    const viewer = await launchDesktop(viewerData);
    electronApp = viewer.app;
    watchExternalRequests(viewer.page, externalRequests);
    await useSafeDefaults(viewer.page);
    await installCollaborationDialogHarness(viewer.app);
    const viewerSettings = await openConnectivitySettings(viewer.page);
    await configureIdentity(viewerSettings, server, {
      displayName: 'Viewer E2E',
      subject: 'viewer-e2e',
    });

    await test.step('revoked and cancelled redemption clear credentials before a valid join', async () => {
      const inviteField = viewerSettings.locator('input[name="collaboration-invite-link"]');
      await inviteField.fill(revokedInviteLink);
      let dialogIndex = await queueCollaborationDialog(viewer.app, 1);
      await viewerSettings.getByRole('button', { name: 'Join room' }).click();
      let dialog = await waitForCollaborationDialog(viewer.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Redeem invite and join collaboration?',
        confirmLabel: 'Redeem and join',
        secrets: [revokedInviteLink],
      });
      await expect(collaborationStatus(viewerSettings)).toContainText(
        'could not redeem and join the collaboration invite',
      );
      await expect(inviteField).toHaveValue('');
      await expect(collaborationStatus(viewerSettings)).not.toContainText('Your role is');
      const revokedToken =
        new URLSearchParams(new URL(revokedInviteLink).hash.slice(1)).get('token') ?? '';
      await expectSecretsAbsent(viewer.page, [revokedInviteLink, revokedToken]);

      await inviteField.fill(inviteLink);
      dialogIndex = await queueCollaborationDialog(viewer.app, 0);
      await viewerSettings.getByRole('button', { name: 'Join room' }).click();
      dialog = await waitForCollaborationDialog(viewer.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Redeem invite and join collaboration?',
        confirmLabel: 'Redeem and join',
        secrets: [inviteLink],
      });
      expect(dialog.detail).toContain('Invite fingerprint:');
      await expect(collaborationStatus(viewerSettings)).toContainText('redemption was cancelled');
      await expect(inviteField).toHaveValue('');

      await inviteField.fill(inviteLink);
      dialogIndex = await queueCollaborationDialog(viewer.app, 1);
      await viewerSettings.getByRole('button', { name: 'Join room' }).click();
      dialog = await waitForCollaborationDialog(viewer.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Redeem invite and join collaboration?',
        confirmLabel: 'Redeem and join',
        secrets: [inviteLink],
      });
      await expect(collaborationStatus(viewerSettings)).toContainText(
        'Connected to room invite-e2e-room',
        {
          timeout: 20_000,
        },
      );
      await expect(collaborationStatus(viewerSettings)).toContainText('Your role is viewer');
      await expect(inviteField).toHaveCount(0);
      await expect(viewerSettings.getByRole('button', { name: 'Create invite' })).toHaveCount(0);
      const inviteToken = new URLSearchParams(new URL(inviteLink).hash.slice(1)).get('token') ?? '';
      await expectSecretsAbsent(viewer.page, [inviteLink, inviteToken]);

      await viewerSettings.getByRole('button', { name: 'Leave room' }).click();
      await expect(collaborationStatus(viewerSettings)).toContainText(
        'Left the collaboration room',
      );
      await expect(collaborationStatus(viewerSettings)).not.toContainText('Your role is viewer');
      await expect(inviteField).toHaveValue('');
    });

    expect(externalRequests).toEqual([]);
  } finally {
    if (electronApp !== null && priorClipboard !== null) {
      await restoreClipboard(electronApp, priorClipboard).catch(() => undefined);
    }
    await electronApp?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function useSafeDefaults(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Use safe defaults' }).click();
  await expect(page.locator('.setup-shell')).toHaveCount(0);
}

async function restoreClipboard(app: ElectronApplication, value: string): Promise<void> {
  await app.evaluate(
    (electron: typeof Electron, clipboardValue) => electron.clipboard.writeText(clipboardValue),
    value,
  );
}

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
  await settings.getByText('Server and advanced options').click();
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

async function expectSecretsAbsent(page: Page, secrets: readonly string[]): Promise<void> {
  const [text, html] = await Promise.all([
    page.locator('body').innerText(),
    page.locator('body').innerHTML(),
  ]);
  for (const secret of secrets) {
    if (secret === '') continue;
    expect(text).not.toContain(secret);
    expect(html).not.toContain(secret);
  }
}
