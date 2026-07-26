import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  openCanvasNodeDetails,
  renameCanvasNode,
  watchExternalRequests,
} from '../support/electron.js';
import {
  installCollaborationDialogHarness,
  queueCollaborationDialog,
  waitForCollaborationDialog,
} from './native-dialogs.js';
import { startCollaborationServer, type CollaborationServerFixture } from './server-fixture.js';

const PRIVATE_PROMPT = 'OWNER_ONLY_PROMPT_37d81f5c';

interface CollaborationTransportObservation {
  readonly authenticationFrameCount: number;
  readonly collaborationDataFrameCount: number;
  readonly sensitiveCollaborationDataFrameCount: number;
}

test('two simultaneous profiles share cursors, comments, and canvas updates without private prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-live-canvas-e2e-'));
  const exportPath = join(root, 'shared-canvas.json');
  const applications: ElectronApplication[] = [];
  const externalRequests: string[] = [];
  let server: CollaborationServerFixture | null = null;

  try {
    server = await startCollaborationServer();
    const editorToken = await createEditorAccess(server);

    const owner = await launchDesktop(join(root, 'owner'));
    applications.push(owner.app);
    watchExternalRequests(owner.page, externalRequests);
    await installCollaborationTransportObserver(owner.app, [
      PRIVATE_PROMPT,
      server.ownerAccessToken,
      editorToken,
    ]);
    await useSafeDefaults(owner.page);
    await owner.page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(owner.page.locator('.project-switcher')).toContainText('forgeboard-demo');
    await exportLocalData(owner.app, owner.page, exportPath);

    const editor = await launchDesktop(join(root, 'editor'));
    applications.push(editor.app);
    watchExternalRequests(editor.page, externalRequests);
    await installCollaborationTransportObserver(editor.app, [
      PRIVATE_PROMPT,
      server.ownerAccessToken,
      editorToken,
    ]);
    await useSafeDefaults(editor.page);
    await importLocalData(editor.app, editor.page, exportPath);
    await editor.page.locator('.recent-list button').click();
    await expect(editor.page.locator('.project-switcher')).toContainText('forgeboard-demo');

    await installCollaborationDialogHarness(owner.app);
    await installCollaborationDialogHarness(editor.app);
    await connectProfile(owner.app, owner.page, server, {
      displayName: 'Owner E2E',
      subject: 'owner-e2e',
      token: server.ownerAccessToken,
    });
    await connectProfile(editor.app, editor.page, server, {
      displayName: 'Editor E2E',
      subject: 'editor-e2e',
      token: editorToken,
    });

    await expect(owner.page.getByText('Sharing · connected')).toBeVisible({
      timeout: 20_000,
    });
    await expect(editor.page.getByText('Sharing · connected')).toBeVisible({
      timeout: 20_000,
    });

    await owner.page
      .locator('.template-section')
      .getByRole('button', { name: /^Product brief/u })
      .click();
    const ownerBrief = owner.page.getByRole('article', {
      name: /^Product brief: /u,
    });
    const editorBrief = editor.page.getByRole('article', {
      name: /^Product brief: /u,
    });
    await expect(editorBrief).toBeVisible({ timeout: 20_000 });

    const ownerDetails = await openCanvasNodeDetails(ownerBrief, 'Comments');
    const sharedComments = ownerDetails.getByRole('region', {
      name: 'Shared comments',
    });
    await sharedComments.getByLabel('Add a comment').fill('Shared from the owner profile.');
    await sharedComments.getByRole('button', { name: 'Share comment' }).click();
    const editorDetails = await openCanvasNodeDetails(editorBrief, 'Comments');
    await expect(editorDetails.getByRole('region', { name: 'Shared comments' })).toContainText(
      'Shared from the owner profile.',
      { timeout: 20_000 },
    );

    const canvas = owner.page.locator('.canvas-region');
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    await owner.page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    const ownerCursor = editor.page.locator('.collaboration-cursor[data-collaborator="owner-e2e"]');
    await expect(ownerCursor).toContainText('Owner E2E', { timeout: 20_000 });

    await renameCanvasNode(editorBrief, 'Edited live by Editor E2E');
    await expect(
      owner.page.getByRole('article', {
        name: 'Product brief: Edited live by Editor E2E',
      }),
    ).toBeVisible({ timeout: 20_000 });

    await expectSecretsAbsent(editor.page, [PRIVATE_PROMPT, server.ownerAccessToken, editorToken]);
    await expectSecretsAbsent(owner.page, [server.ownerAccessToken, editorToken]);
    await owner.page.waitForTimeout(500);
    const ownerTransport = await readCollaborationTransportObservation(owner.app);
    const editorTransport = await readCollaborationTransportObservation(editor.app);
    expect(ownerTransport.authenticationFrameCount).toBeGreaterThan(0);
    expect(editorTransport.authenticationFrameCount).toBeGreaterThan(0);
    expect(ownerTransport.collaborationDataFrameCount).toBeGreaterThan(0);
    expect(editorTransport.collaborationDataFrameCount).toBeGreaterThan(0);
    expect(ownerTransport.sensitiveCollaborationDataFrameCount).toBe(0);
    expect(editorTransport.sensitiveCollaborationDataFrameCount).toBe(0);
    expect(externalRequests).toEqual([]);
  } finally {
    await Promise.all(
      applications.toReversed().map(async (application) => {
        await closeElectronAfterTest(application);
      }),
    );
    await server?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function useSafeDefaults(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Use safe defaults' }).click();
  await expect(page.locator('.setup-shell')).toHaveCount(0);
}

async function installCollaborationTransportObserver(
  app: ElectronApplication,
  sensitiveValues: readonly string[],
): Promise<void> {
  await app.evaluate(
    (_, values) => {
      const scope = globalThis as typeof globalThis & {
        __forgeboardCollaborationTransportObservation?: CollaborationTransportObservation;
        __forgeboardOriginalWebSocket?: typeof WebSocket;
      };
      const OriginalWebSocket = scope.__forgeboardOriginalWebSocket ?? WebSocket;
      scope.__forgeboardOriginalWebSocket = OriginalWebSocket;
      const encodedValues = values.map((value) => new TextEncoder().encode(value));
      const observation = {
        authenticationFrameCount: 0,
        collaborationDataFrameCount: 0,
        sensitiveCollaborationDataFrameCount: 0,
      };
      scope.__forgeboardCollaborationTransportObservation = observation;

      const readVarUint = (
        bytes: Uint8Array,
        initialOffset: number,
      ): { value: number; offset: number } | null => {
        let value = 0;
        let multiplier = 1;
        let offset = initialOffset;
        while (offset < bytes.byteLength && multiplier <= 2 ** 49) {
          const byte = bytes[offset];
          if (byte === undefined) return null;
          value += (byte & 0x7f) * multiplier;
          offset += 1;
          if ((byte & 0x80) === 0) return { value, offset };
          multiplier *= 128;
        }
        return null;
      };
      const containsBytes = (haystack: Uint8Array, needle: Uint8Array): boolean => {
        if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false;
        for (let start = 0; start <= haystack.byteLength - needle.byteLength; start += 1) {
          let matches = true;
          for (let index = 0; index < needle.byteLength; index += 1) {
            if (haystack[start + index] !== needle[index]) {
              matches = false;
              break;
            }
          }
          if (matches) return true;
        }
        return false;
      };
      const messageType = (bytes: Uint8Array): number | null => {
        const nameLength = readVarUint(bytes, 0);
        if (nameLength === null) return null;
        const typeOffset = nameLength.offset + nameLength.value;
        return readVarUint(bytes, typeOffset)?.value ?? null;
      };

      class ObservedWebSocket extends OriginalWebSocket {
        public override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          let bytes: Uint8Array | null = null;
          if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
          }
          if (bytes !== null) {
            const type = messageType(bytes);
            if (type === 2) {
              observation.authenticationFrameCount += 1;
            } else if (type === 0 || type === 1 || type === 5) {
              observation.collaborationDataFrameCount += 1;
              if (encodedValues.some((value) => containsBytes(bytes, value))) {
                observation.sensitiveCollaborationDataFrameCount += 1;
              }
            }
          }
          super.send(data);
        }
      }

      scope.WebSocket = ObservedWebSocket;
    },
    [...sensitiveValues],
  );
}

async function readCollaborationTransportObservation(
  app: ElectronApplication,
): Promise<CollaborationTransportObservation> {
  return await app.evaluate(() => {
    const observation = (
      globalThis as typeof globalThis & {
        __forgeboardCollaborationTransportObservation?: CollaborationTransportObservation;
      }
    ).__forgeboardCollaborationTransportObservation;
    if (observation === undefined) throw new Error('Collaboration transport observer is missing.');
    return { ...observation };
  });
}

async function exportLocalData(app: ElectronApplication, page: Page, path: string): Promise<void> {
  await app.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showSaveDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePath: selectedPath }),
    });
  }, path);
  const settings = await openDataSettings(page);
  await settings.getByRole('button', { name: 'Export all local data' }).click();
  await expect(settings.getByText(`Local data exported to ${path}`)).toBeVisible();
  await settings.getByRole('button', { name: 'Close settings' }).click();
}

async function importLocalData(app: ElectronApplication, page: Page, path: string): Promise<void> {
  await app.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePaths: [selectedPath] }),
    });
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: () => Promise.resolve({ response: 1, checkboxChecked: false }),
    });
  }, path);
  const settings = await openDataSettings(page);
  await settings.getByLabel('How to import').selectOption('replace');
  await settings.getByRole('button', { name: 'Choose export file' }).click();
  const disclosure = settings.getByRole('region', {
    name: 'Confirm local data import',
  });
  await expect(disclosure).toBeVisible();
  await disclosure.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(settings).toBeHidden();
}

async function openDataSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: 'Data & privacy' }).click();
  return settings;
}

async function connectProfile(
  app: ElectronApplication,
  page: Page,
  server: CollaborationServerFixture,
  identity: { displayName: string; subject: string; token: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: 'Connectivity', exact: true }).click();
  await settings.getByText('Advanced', { exact: true }).click();
  await settings.getByRole('checkbox', { name: /Enable collaboration/u }).check();
  await settings.getByLabel('Collaboration server URL').fill(server.webSocketUrl);
  await settings
    .getByRole('textbox', { name: /Collaboration management API URL/u })
    .fill(server.httpUrl);
  await settings.getByLabel('Collaboration display name').fill(identity.displayName);
  await settings.getByLabel('Collaborator ID').fill(identity.subject);
  await settings.getByLabel('Collaboration room').fill('invite-e2e-room');
  await settings.locator('input[name="collaboration-access-token"]').fill(identity.token);
  const dialogIndex = await queueCollaborationDialog(app, 1);
  await settings.getByRole('button', { name: 'Connect with access token' }).click();
  await waitForCollaborationDialog(app, dialogIndex);
  await expect(settings.locator('.recovery-guidance[role="status"]')).toContainText(
    `Your role is ${identity.subject === 'owner-e2e' ? 'owner' : 'editor'}`,
    { timeout: 20_000 },
  );
  await settings.getByRole('button', { name: /Save settings/u }).click();
  await expect(settings).toBeHidden();
}

async function createEditorAccess(server: CollaborationServerFixture): Promise<string> {
  const inviteResponse = await fetch(`${server.httpUrl}/v1/rooms/invite-e2e-room/invites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.ownerAccessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      role: 'editor',
      expiresInSeconds: 600,
      maxUses: 1,
    }),
  });
  const inviteBody = (await inviteResponse.json()) as {
    invite?: { token?: unknown };
  };
  if (inviteResponse.status !== 201 || typeof inviteBody.invite?.token !== 'string') {
    throw new Error(`Could not create editor invite (${String(inviteResponse.status)}).`);
  }
  const redemption = await fetch(`${server.httpUrl}/v1/invites/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: inviteBody.invite.token,
      subject: 'editor-e2e',
      displayName: 'Editor E2E',
    }),
  });
  const access = (await redemption.json()) as { accessToken?: unknown };
  if (redemption.status !== 200 || typeof access.accessToken !== 'string') {
    throw new Error(`Could not redeem editor invite (${String(redemption.status)}).`);
  }
  return access.accessToken;
}

async function expectSecretsAbsent(page: Page, secrets: readonly string[]): Promise<void> {
  const [text, html] = await Promise.all([
    page.locator('body').innerText(),
    page.locator('body').innerHTML(),
  ]);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
    expect(html).not.toContain(secret);
  }
}
