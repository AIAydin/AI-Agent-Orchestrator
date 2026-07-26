import { createHash, randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type Shell,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import type { IpcResult } from '../../shared/application/contracts.js';
import {
  UPDATE_IPC_CHANNELS,
  UpdateCancelResultSchema,
  UpdateCheckInputSchema,
  UpdateCheckResultSchema,
  UpdateOpenReleaseInputSchema,
  UpdateReleaseSchema,
  type UpdateCheckInput,
  type UpdateCheckResult,
  type UpdateRelease,
} from '../../shared/updates/contracts.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { createNativeOutboundConfirmation } from '../outbound/native-confirmation.js';
import {
  OutboundActionGate,
  type OutboundActionDisclosure,
  type OutboundAuditSink,
  type OutboundExecutionPermit,
} from '../outbound/outbound-action-gate.js';
import { executeUpdateReleaseRequest } from '../outbound/outbound-executors.js';

const OFFICIAL_RELEASE_PATH = '/AIAydin/AI-Agent-Orchestrator/releases/tag/';
const KNOWN_RELEASE_TTL_MS = 5 * 60_000;

const GitHubReleaseSchema = z
  .object({
    id: z.number().int().positive(),
    tag_name: z.string().min(1).max(128),
    name: z.string().max(512).nullable(),
    html_url: z.string().url().max(2_048),
    published_at: z.string().datetime().nullable(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  })
  .passthrough();
const GitHubReleasesSchema = z.array(GitHubReleaseSchema).max(20);

export interface UpdateOperations {
  request(permit: OutboundExecutionPermit, signal: AbortSignal): Promise<string>;
  openExternal(url: string): Promise<void>;
}

interface UpdateDialog {
  showMessageBox(
    parent: BrowserWindow,
    options: Electron.MessageBoxOptions,
  ): Promise<{ response: number }>;
}

interface ActiveCheck {
  readonly controller: AbortController;
  readonly ownerId: string;
}

interface KnownRelease {
  readonly release: UpdateRelease;
  readonly expiresAtMs: number;
}

const DEFAULT_OPERATIONS = (shell: Pick<Shell, 'openExternal'>): UpdateOperations => ({
  request: async (permit, signal) => await executeUpdateReleaseRequest(permit, signal),
  openExternal: async (url) => {
    await shell.openExternal(url, { activate: true });
  },
});

export class UpdateIpcService {
  readonly #registered: string[] = [];
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #knownReleases = new Map<string, Map<number, KnownRelease>>();
  readonly #active = new Map<string, ActiveCheck>();
  readonly #pendingOwners = new Set<string>();
  readonly #outbound: OutboundActionGate;
  readonly #operations: UpdateOperations;
  #disposed = false;

  public constructor(
    private readonly dialog: UpdateDialog,
    shell: Pick<Shell, 'openExternal'>,
    private readonly audit: OutboundAuditSink,
    private readonly currentVersion: () => string,
    outbound?: OutboundActionGate,
    operations?: UpdateOperations,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#outbound = outbound ?? new OutboundActionGate(audit);
    this.#operations = operations ?? DEFAULT_OPERATIONS(shell);
  }

  registerIpcHandlers(): void {
    if (this.#registered.length > 0)
      throw new Error('The update IPC handlers are already registered.');
    this.#handle(
      UPDATE_IPC_CHANNELS.check,
      z.tuple([UpdateCheckInputSchema]),
      async (event, input) => await this.#check(event, input),
    );
    this.#handle(UPDATE_IPC_CHANNELS.cancel, z.tuple([]), (event) => this.#cancel(event));
    this.#handle(
      UPDATE_IPC_CHANNELS.openRelease,
      z.tuple([UpdateOpenReleaseInputSchema]),
      async (event, input) => await this.#openRelease(event, input.releaseId),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registered) ipcMain.removeHandler(channel);
    this.#registered.length = 0;
    for (const active of this.#active.values()) active.controller.abort();
    this.#active.clear();
    this.#knownReleases.clear();
  }

  async #check(
    event: IpcMainInvokeEvent,
    input: UpdateCheckInput,
  ): Promise<UpdateCheckResult | null> {
    const ownerId = this.#ownerId(event.sender);
    if (this.#pendingOwners.has(ownerId))
      throw new Error('An update check is already pending for this window.');
    this.#pendingOwners.add(ownerId);
    try {
      return await this.#performCheck(event, input);
    } finally {
      this.#pendingOwners.delete(ownerId);
    }
  }

  async #performCheck(
    event: IpcMainInvokeEvent,
    input: UpdateCheckInput,
  ): Promise<UpdateCheckResult | null> {
    const parent = this.#parent(event, 'check for updates');
    const ownerId = this.#ownerId(event.sender);
    if (this.#active.has(ownerId)) throw new Error('An update check is already running.');
    if (input.channel === 'disabled') throw new Error('Update checks are disabled.');
    const channel = input.channel;
    this.#knownReleases.delete(ownerId);
    const disclosure = updateDisclosure(channel);
    const plan = this.#outbound.prepare(ownerId, disclosure);
    const confirmation = createNativeOutboundConfirmation({
      show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
      assertCurrent: () => this.#assertCurrent(event, parent),
    });
    const result = await this.#outbound.confirmAndExecute({
      ownerId,
      planId: plan.id,
      confirmation,
      currentDisclosure: () => updateDisclosure(channel),
      execute: async (permit) => {
        const controller = new AbortController();
        this.#active.set(ownerId, { controller, ownerId });
        try {
          const raw = await this.#operations.request(permit, controller.signal);
          this.#assertCurrent(event, parent);
          const value = buildUpdateResult(raw, channel, this.currentVersion(), this.now());
          const releases = new Map<number, KnownRelease>();
          if (value.release !== null)
            releases.set(value.release.id, {
              release: value.release,
              expiresAtMs: this.now().getTime() + KNOWN_RELEASE_TTL_MS,
            });
          this.#knownReleases.set(ownerId, releases);
          return value;
        } finally {
          this.#active.delete(ownerId);
        }
      },
    });
    return result.outcome === 'denied' ? null : UpdateCheckResultSchema.parse(result.value);
  }

  #cancel(event: IpcMainInvokeEvent): { cancelled: boolean } {
    assertLiveMainFrame(event, 'Update cancellation');
    const ownerId = this.#ownerId(event.sender);
    const active = this.#active.get(ownerId);
    active?.controller.abort();
    return UpdateCancelResultSchema.parse({ cancelled: active !== undefined });
  }

  async #openRelease(event: IpcMainInvokeEvent, releaseId: number): Promise<boolean> {
    const parent = this.#parent(event, 'open an update release');
    const ownerId = this.#ownerId(event.sender);
    const known = this.#knownReleases.get(ownerId)?.get(releaseId);
    if (known === undefined || known.expiresAtMs <= this.now().getTime()) {
      this.#knownReleases.delete(ownerId);
      if (known !== undefined)
        this.#auditOpen(known.release.url, 'denied', 'release-evidence-expired');
      throw new Error('Run a fresh update check before opening this release.');
    }
    const release = known.release;
    const assertOpenCurrent = (reason: string): void => {
      try {
        this.#assertCurrent(event, parent);
      } catch (error) {
        this.#auditOpen(release.url, 'failed', reason);
        throw error;
      }
    };
    let response: { response: number };
    try {
      response = await this.dialog.showMessageBox(parent, {
        type: 'warning',
        title: 'Open release in your system browser?',
        message: `Open Artemis ${release.version} on GitHub?`,
        detail: release.url,
        buttons: ['Cancel', 'Open release'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    } catch (error) {
      this.#auditOpen(release.url, 'failed', 'native-confirmation-failed');
      throw error;
    }
    assertOpenCurrent('origin-window-changed-after-confirmation');
    if (response.response !== 1) {
      this.#auditOpen(release.url, 'denied', 'native-confirmation-cancelled');
      return false;
    }
    const current = this.#knownReleases.get(ownerId)?.get(releaseId);
    if (
      current === undefined ||
      current.release.url !== release.url ||
      current.expiresAtMs <= this.now().getTime()
    ) {
      this.#auditOpen(release.url, 'failed', 'release-evidence-changed-or-expired');
      throw new Error('The selected release changed after approval.');
    }
    assertOpenCurrent('origin-window-changed-before-open');
    this.#knownReleases.delete(ownerId);
    try {
      this.#auditOpen(release.url, 'allowed');
      await this.#operations.openExternal(release.url);
      return true;
    } catch (error) {
      this.#auditOpen(release.url, 'failed', 'system-browser-open-failed');
      throw error;
    }
  }

  #auditOpen(url: string, outcome: 'allowed' | 'denied' | 'failed', reason?: string): void {
    this.audit.appendAudit('external-navigation', 'open-update-release', outcome, {
      destinationKind: 'release-page',
      urlSha256: createHash('sha256').update(url).digest('hex'),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  #ownerId(owner: WebContents): string {
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const id = `updates:${String(owner.id)}:${randomUUID()}`;
    this.#ownerIds.set(owner, id);
    owner.once('destroyed', () => {
      this.#active.get(id)?.controller.abort();
      this.#active.delete(id);
      this.#pendingOwners.delete(id);
      this.#knownReleases.delete(id);
      this.#outbound.discardOwner(id);
    });
    return id;
  }

  #parent(event: IpcMainInvokeEvent, action: string): BrowserWindow {
    assertLiveMainFrame(event, `Update ${action}`);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed())
      throw new Error(`A live Artemis window is required to ${action}.`);
    return parent;
  }

  #assertCurrent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
    if (this.#disposed) throw new Error('The update service has been disposed.');
    assertLiveMainFrame(event, 'Update operation');
    if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
      throw new Error('The originating Artemis window changed or closed.');
    }
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    schema: z.ZodType<Args>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    ipcMain.handle(channel, async (event, ...raw: unknown[]): Promise<IpcResult<Output>> => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Artemis rejected an invalid update request.',
          },
        };
      }
      try {
        const value = await operation(event, ...parsed.data);
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'OPERATION_FAILED',
            message:
              error instanceof z.ZodError
                ? 'The update server response did not match the expected GitHub release format.'
                : error instanceof Error
                  ? error.message
                  : 'The update operation failed.',
          },
        };
      }
    });
    this.#registered.push(channel);
  }
}

export function buildUpdateResult(
  raw: string,
  channel: 'stable' | 'prerelease',
  currentVersion: string,
  now: Date,
): UpdateCheckResult {
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024)
    throw new Error('The update response exceeded 1 MiB.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('The update server returned malformed JSON.');
  }
  const entries = GitHubReleasesSchema.parse(decoded);
  const releases = entries
    .filter(
      (entry) =>
        !entry.draft &&
        entry.published_at !== null &&
        (channel === 'prerelease' || !entry.prerelease),
    )
    .map(toRelease)
    .filter((release): release is UpdateRelease => release !== null)
    .sort((left, right) => compareVersions(right.version, left.version));
  const release = releases[0] ?? null;
  return UpdateCheckResultSchema.parse({
    channel,
    currentVersion,
    checkedAt: now.toISOString(),
    status:
      release === null
        ? 'no-release'
        : compareVersions(release.version, normalizeVersion(currentVersion)) > 0
          ? 'update-available'
          : 'up-to-date',
    release,
  });
}

function toRelease(entry: z.infer<typeof GitHubReleaseSchema>): UpdateRelease | null {
  const version = parseTagVersion(entry.tag_name);
  if (version === null || entry.published_at === null) return null;
  const url = new URL(entry.html_url);
  if (
    url.origin !== 'https://github.com' ||
    url.pathname !== `${OFFICIAL_RELEASE_PATH}${encodeURIComponent(entry.tag_name)}` ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    return null;
  return UpdateReleaseSchema.parse({
    id: entry.id,
    version,
    tagName: entry.tag_name,
    name: entry.name?.trim() || `Artemis ${version}`,
    url: url.toString(),
    publishedAt: entry.published_at,
    prerelease: entry.prerelease,
  });
}

function updateDisclosure(channel: 'stable' | 'prerelease'): OutboundActionDisclosure {
  return {
    action: 'update-check',
    title: 'Check GitHub for Artemis updates?',
    summary: `Contact the official Artemis release feed for the ${channel} channel?`,
    confirmLabel: 'Check for updates',
    destination: {
      kind: 'release-server',
      endpoint: 'api.github.com',
      resource: '/repos/AIAydin/AI-Agent-Orchestrator/releases?per_page=20',
      transport: 'HTTPS GitHub API',
    },
    details: [{ label: 'Update channel', value: channel }],
    warning:
      'Artemis sends no repository data, prompts, credentials, identifiers, or telemetry. GitHub receives the ordinary network metadata required for this single request.',
  };
}

function parseTagVersion(tag: string): string | null {
  const match =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u.exec(
      tag.trim(),
    );
  return match?.[1] ?? null;
}

function normalizeVersion(version: string): string {
  const parsed =
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u.exec(
      version.trim(),
    )?.[1] ?? null;
  if (parsed === null)
    throw new Error('The running Artemis version is not valid semantic versioning.');
  return parsed;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): [bigint[], string[]] => {
    const normalized = normalizeVersion(value);
    const precedence = normalized.split('+', 1)[0] ?? normalized;
    const separator = precedence.indexOf('-');
    const core = separator === -1 ? precedence : precedence.slice(0, separator);
    const prerelease = separator === -1 ? undefined : precedence.slice(separator + 1);
    return [
      core.split('.').map((part) => BigInt(part)),
      prerelease === undefined ? [] : prerelease.split('.'),
    ];
  };
  const [leftCore, leftPre] = parse(left);
  const [rightCore, rightPre] = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const leftNumber = leftCore[index] ?? 0n;
    const rightNumber = rightCore[index] ?? 0n;
    if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
  }
  if (leftPre.length === 0 || rightPre.length === 0)
    return leftPre.length === rightPre.length ? 0 : leftPre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? BigInt(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? BigInt(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null)
      return leftNumber === rightNumber ? 0 : leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
