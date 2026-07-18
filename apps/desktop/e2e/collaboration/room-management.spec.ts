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
import {
  startEmptyCollaborationServer,
  type EmptyCollaborationServerFixture,
} from './server-fixture.js';

test('room creation, member administration, audit, and renewal work entirely through the UI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-room-management-e2e-'));
  const ownerData = join(root, 'owner-user-data');
  const applications: ElectronApplication[] = [];
  const externalRequests: string[] = [];
  let server: EmptyCollaborationServerFixture | null = null;
  let priorClipboard: string | null = null;

  try {
    server = await startEmptyCollaborationServer();
    const owner = await launchDesktop(ownerData);
    applications.push(owner.app);
    priorClipboard = await owner.app.evaluate(({ clipboard }) => clipboard.readText());
    watchExternalRequests(owner.page, externalRequests);
    await useSafeDefaults(owner.page);
    await installCollaborationDialogHarness(owner.app);
    const ownerSettings = await openConnectivitySettings(owner.page);
    await configureIdentity(ownerSettings, server, 'Owner E2E', 'owner-e2e');
    await ownerSettings.getByLabel('Collaboration room').fill('management-e2e-room');

    await test.step('cancelled bootstrap makes no room before approved UI creation', async () => {
      const adminToken = ownerSettings.getByLabel(/^Server administrator token/u);
      await adminToken.fill(server!.adminToken);
      let dialogIndex = await queueCollaborationDialog(owner.app, 0);
      await ownerSettings.getByRole('button', { name: 'Create room and connect' }).click();
      let dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Create collaboration room?',
        confirmLabel: 'Create and connect',
        secrets: [server!.adminToken],
      });
      await expect(adminToken).toHaveValue('');
      await expect(collaborationStatus(ownerSettings)).toContainText('Room creation was cancelled');

      await adminToken.fill(server!.adminToken);
      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Create room and connect' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Create collaboration room?',
        confirmLabel: 'Create and connect',
        secrets: [server!.adminToken],
      });
      expect(dialog.detail).toContain(`Address: ${server!.httpUrl}/`);
      expect(dialog.detail).toContain('Item: management-e2e-room');
      await expect(collaborationStatus(ownerSettings)).toContainText('Your role is owner', {
        timeout: 20_000,
      });
      await expect(adminToken).toHaveCount(0);
      await expect(
        ownerSettings.getByRole('heading', { name: 'Room administration' }),
      ).toBeVisible();
      await expectSecretsAbsent(owner.page, [server!.adminToken]);
    });

    let inviteLink = '';
    await test.step('a second UI profile redeems an editor invite', async () => {
      await ownerSettings.getByLabel('Invite role').selectOption('editor');
      let dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Create invite' }).click();
      let dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
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
      const editorInvite = sessionInvite(ownerSettings, 'editor');
      await expect(editorInvite).toBeVisible();

      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await editorInvite.getByRole('button', { name: 'Copy' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Copy collaboration invite?',
        confirmLabel: 'Copy invite',
      });
      inviteLink = await owner.app.evaluate(({ clipboard }) => clipboard.readText());
      expect(inviteLink).toMatch(/^forgeboard:\/\/collaboration\/invite#token=\S+$/u);
      await expectSecretsAbsent(owner.page, [inviteLink, inviteToken(inviteLink)]);
      const member = await launchDesktop(join(root, 'member-user-data'));
      applications.push(member.app);
      watchExternalRequests(member.page, externalRequests);
      await useSafeDefaults(member.page);
      await installCollaborationDialogHarness(member.app);
      const memberSettings = await openConnectivitySettings(member.page);
      await configureIdentity(memberSettings, server!, 'Editor E2E', 'editor-e2e');
      const inviteField = memberSettings.locator('input[name="collaboration-invite-link"]');
      await inviteField.fill(inviteLink);
      dialogIndex = await queueCollaborationDialog(member.app, 1);
      await memberSettings.getByRole('button', { name: 'Join with invite' }).click();
      dialog = await waitForCollaborationDialog(member.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Redeem invite and join collaboration?',
        confirmLabel: 'Redeem and join',
        secrets: [inviteLink],
      });
      await expect(collaborationStatus(memberSettings)).toContainText('Your role is editor', {
        timeout: 20_000,
      });
      await expect(inviteField).toHaveValue('');
      await expect(
        memberSettings.getByRole('heading', { name: 'Room administration' }),
      ).toHaveCount(0);
      await expectSecretsAbsent(member.page, [inviteLink, inviteToken(inviteLink)]);
      await expect(collaborationStatus(ownerSettings)).toContainText('Your role is owner');
    });

    await test.step('owner loads, updates, and revokes the durable member', async () => {
      let dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Refresh room members' }).click();
      let dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Load collaboration members?',
        confirmLabel: 'Load members',
        secrets: [server!.adminToken, inviteLink],
      });
      await expect(
        ownerSettings.getByText('Editor E2E (editor-e2e)', { exact: true }),
      ).toBeVisible();
      await expect(ownerSettings.getByText('Owner E2E (owner-e2e)', { exact: true })).toBeVisible();
      await expect(ownerSettings.getByLabel(/Role for Owner E2E/u)).toHaveCount(0);

      await ownerSettings.getByLabel('Role for Editor E2E (editor-e2e)').selectOption('viewer');
      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings
        .getByRole('button', {
          name: 'Review role change for Editor E2E (editor-e2e)',
        })
        .click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Change collaboration member role?',
        confirmLabel: 'Change role',
        secrets: [server!.adminToken, inviteLink],
      });
      expect(dialog.detail).toContain('Member ID: editor-e2e');
      await expect(ownerSettings.getByText(/Updated Editor E2E to viewer/u)).toBeVisible();
      await expect(
        ownerSettings.getByText('Editor E2E (editor-e2e)', { exact: true }).locator('..'),
      ).toContainText('viewer');

      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Revoke Editor E2E (editor-e2e)' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Revoke collaboration member?',
        confirmLabel: 'Revoke member',
        secrets: [server!.adminToken, inviteLink],
      });
      await expect(ownerSettings.getByText(/Revoked Editor E2E/u)).toBeVisible();
      await expect(ownerSettings.getByText('Editor E2E (editor-e2e)', { exact: true })).toHaveCount(
        0,
      );
    });

    await test.step('owner reads the real audit trail and renews without rendered credentials', async () => {
      let dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Refresh room audit' }).click();
      let dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Load collaboration audit history?',
        confirmLabel: 'Load audit history',
        secrets: [server!.adminToken, inviteLink],
      });
      const audit = ownerSettings.getByRole('list', {
        name: 'Room audit events',
      });
      await expect(audit.getByText(/room.created/u)).toBeVisible();
      await expect(audit.getByText(/invite.redeemed/u)).toBeVisible();
      await expect(audit.getByText(/membership.role_changed/u)).toBeVisible();
      await expect(audit.getByText(/membership.revoked/u)).toBeVisible();

      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Renew owner session' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Renew owner session?',
        confirmLabel: 'Renew session',
        secrets: [server!.adminToken, inviteLink],
      });
      await expect(collaborationStatus(ownerSettings)).toContainText('Renewed the owner session');
      await expect(ownerSettings.getByText(/Owner session expires:/u)).not.toContainText(
        'unavailable',
      );
      await expectSecretsAbsent(owner.page, [
        server!.adminToken,
        inviteLink,
        inviteToken(inviteLink),
      ]);

      await ownerSettings.getByRole('button', { name: 'Leave room' }).click();
      const roomAccessAction = ownerSettings.getByLabel('Room access action');
      await expect(roomAccessAction).toBeEnabled();
      await roomAccessAction.selectOption('recover');
      await ownerSettings.getByLabel(/^Server administrator token/u).fill(server!.adminToken);
      dialogIndex = await queueCollaborationDialog(owner.app, 1);
      await ownerSettings.getByRole('button', { name: 'Rotate owner access and connect' }).click();
      dialog = await waitForCollaborationDialog(owner.app, dialogIndex);
      expectCancelDefaultDialog(dialog, {
        title: 'Recover room ownership?',
        confirmLabel: 'Recover and connect',
        secrets: [server!.adminToken, inviteLink],
      });
      await expect(collaborationStatus(ownerSettings)).toContainText(
        'Rotated owner access and connected',
        { timeout: 20_000 },
      );
      await expect(ownerSettings.getByLabel(/^Server administrator token/u)).toHaveCount(0);
      await expectSecretsAbsent(owner.page, [
        server!.adminToken,
        inviteLink,
        inviteToken(inviteLink),
      ]);
    });

    await test.step('server loss is visible while local canvas work remains usable', async () => {
      await server!.stop();
      server = null;
      await expect(collaborationStatus(ownerSettings)).toContainText(
        'Reconnecting to the approved room',
        { timeout: 20_000 },
      );

      await ownerSettings.getByRole('button', { name: /Save settings/u }).click();
      await expect(ownerSettings).toBeHidden();
      await owner.page.getByRole('button', { name: /Explore the safe demo/i }).click();
      await expect(owner.page.locator('.project-switcher')).toContainText('forgeboard-demo');
      await expect(
        owner.page.getByText(/^Sharing · (?:reconnecting|error|offline)$/u),
      ).toBeVisible();
      await owner.page
        .locator('.template-section')
        .getByRole('button', { name: /Product brief/u })
        .click();
      await expect(
        owner.page.getByRole('article', { name: 'Product brief: Product brief' }),
      ).toBeVisible();
      await expect(owner.page.getByText('Saved locally')).toBeVisible();
    });

    expect(externalRequests).toEqual([]);
  } finally {
    if (priorClipboard !== null) {
      for (const application of applications.toReversed()) {
        try {
          await restoreClipboard(application, priorClipboard);
          break;
        } catch {
          // Try the next application; earlier profiles may already be closed.
        }
      }
    }
    await Promise.all(
      applications.map(async (application) => await application.close().catch(() => undefined)),
    );
    await server?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function useSafeDefaults(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Use safe defaults' }).click();
  await expect(page.locator('.setup-shell')).toHaveCount(0);
}

async function openConnectivitySettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: 'Connectivity', exact: true }).click();
  return settings;
}

async function configureIdentity(
  settings: Locator,
  server: EmptyCollaborationServerFixture,
  displayName: string,
  subject: string,
): Promise<void> {
  await settings.getByRole('checkbox', { name: /Enable collaboration/u }).check();
  await settings.getByLabel('Collaboration server URL').fill(server.webSocketUrl);
  await settings
    .getByRole('textbox', { name: /Collaboration management API URL/u })
    .fill(server.httpUrl);
  await settings.getByLabel('Collaboration display name').fill(displayName);
  await settings.getByLabel('Collaborator ID').fill(subject);
}

function sessionInvite(settings: Locator, role: 'editor'): Locator {
  return settings
    .getByRole('list', { name: 'Room invite history' })
    .getByRole('listitem')
    .filter({ hasText: new RegExp(`^${role} \\u00b7`, 'u') });
}

function collaborationStatus(settings: Locator): Locator {
  return settings.locator('.recovery-guidance[role="status"]');
}

function inviteToken(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get('token') ?? '';
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

async function restoreClipboard(app: ElectronApplication, value: string): Promise<void> {
  await app.evaluate(
    (electron: typeof Electron, clipboardValue) => electron.clipboard.writeText(clipboardValue),
    value,
  );
}
