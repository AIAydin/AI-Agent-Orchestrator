import { randomUUID } from 'node:crypto';

import {
  ExtensionRuntimeError,
  compareSemanticVersions,
  createExtensionApproval,
  type InstalledExtension,
  type ExtensionInstallPlan,
  type ExtensionManifest,
  type LocalExtensionService,
} from '@forgeboard/extension-runtime';

import {
  ExtensionDiscoveryViewSchema,
  ExtensionInstallPlanViewSchema,
  type ExtensionDiscoveryView,
  type ExtensionInstallPlanView,
  type ExtensionManifestView,
  type InstalledExtensionView,
  type QuarantinedExtensionView,
} from '../shared/contracts.js';
import type { TrustedExtensionLedgerRecord, TrustedExtensionState } from './storage.js';

const PLAN_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_PENDING_PLANS_PER_OWNER = 64;

export interface ExtensionAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void;
}

export interface ExtensionTrustStore extends ExtensionAuditSink {
  stageTrustedExtension(record: TrustedExtensionLedgerRecord): TrustedExtensionLedgerRecord;
  activateTrustedExtension(
    extensionId: string,
    operationId: string,
    activatedAt?: Date,
  ): TrustedExtensionLedgerRecord;
  restoreActiveTrustedExtension(
    previousRecord: TrustedExtensionLedgerRecord,
    failedOperationId: string,
    restoredAt?: Date,
  ): TrustedExtensionLedgerRecord;
  getTrustedExtension(extensionId: string): TrustedExtensionLedgerRecord | undefined;
  listTrustedExtensions(state?: TrustedExtensionState): TrustedExtensionLedgerRecord[];
  revokeTrustedExtension(
    extensionId: string,
    removalOperationId: string,
    revokedAt?: Date,
  ): TrustedExtensionLedgerRecord;
  purgeTrustedExtension(extensionId: string, removalOperationId: string): boolean;
}

interface TrustedInstalledExtension {
  readonly extension: InstalledExtension;
  readonly ledger: TrustedExtensionLedgerRecord;
}

interface TrustedDiscovery {
  readonly active: readonly TrustedInstalledExtension[];
  readonly quarantined: readonly QuarantinedExtensionView[];
  readonly invalid: ExtensionDiscoveryView['invalid'];
}

interface PendingPlan {
  readonly ownerId: number;
  readonly operation: 'install' | 'update';
  readonly currentVersion: string | null;
  readonly plan: ExtensionInstallPlan;
  readonly expiresAtMs: number;
}

export class ExtensionManager {
  readonly #plans = new Map<string, PendingPlan>();
  #mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly service: LocalExtensionService,
    private readonly trustStore: ExtensionTrustStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(): Promise<ExtensionDiscoveryView> {
    const discovery = await this.#discoverTrusted();
    return ExtensionDiscoveryViewSchema.parse({
      registryPath: this.service.registryRoot,
      installed: discovery.active.map(({ extension, ledger }) =>
        activeExtensionView(extension, ledger),
      ),
      quarantined: discovery.quarantined,
      invalid: discovery.invalid,
    });
  }

  public async listActiveAgentAdapters(): Promise<
    ExtensionManifest['contributes']['agentAdapters']
  > {
    const discovery = await this.#discoverTrusted();
    return discovery.active.flatMap(
      ({ extension }) => extension.manifest.contributes.agentAdapters,
    );
  }

  public async plan(selectedPath: string, ownerId: number): Promise<ExtensionInstallPlanView> {
    this.#discardExpiredPlans();
    try {
      const plan = await this.service.planFromSelectedPath(selectedPath);
      const discovery = await this.service.discover();
      const existing = discovery.installed.find(
        (extension) => extension.manifest.id === plan.manifest.id,
      );
      const operation = existing === undefined ? 'install' : 'update';
      const currentVersion = existing?.manifest.version ?? null;
      if (discovery.invalid.some((entry) => entry.entryName === plan.manifest.id)) {
        throw new ExtensionRuntimeError(
          'REGISTRY_CORRUPT',
          `The existing ${plan.manifest.id} registry entry is invalid and must not be overwritten.`,
        );
      }
      const existingLedger = this.trustStore.getTrustedExtension(plan.manifest.id);
      if (
        operation === 'install' &&
        existingLedger !== undefined &&
        existingLedger.state !== 'revoked'
      ) {
        throw new ExtensionRuntimeError(
          'APPROVAL_MISMATCH',
          `Extension ${plan.manifest.id} already has ${existingLedger.state} trusted state without a matching registry snapshot.`,
        );
      }
      if (
        existing !== undefined &&
        compareSemanticVersions(plan.manifest.version, existing.manifest.version) <= 0
      ) {
        throw new ExtensionRuntimeError(
          'DOWNGRADE_DENIED',
          `Update version ${plan.manifest.version} must be newer than ${existing.manifest.version}.`,
        );
      }
      const planId = randomUUID();
      const expiresAtMs = this.now().getTime() + PLAN_LIFETIME_MS;
      const pending = {
        ownerId,
        operation,
        currentVersion,
        plan,
        expiresAtMs,
      } satisfies PendingPlan;
      this.#plans.set(planId, pending);
      this.#boundPendingPlans(ownerId);
      this.trustStore.appendAudit('extension', `plan-${operation}`, 'allowed', {
        extensionId: plan.manifest.id,
        version: plan.manifest.version,
        manifestDigest: plan.manifestDigest,
        snapshotDigest: plan.snapshotDigest,
        requestedPermissions: plan.requestedPermissions,
      });
      return pendingPlanView(planId, pending);
    } catch (error) {
      this.trustStore.appendAudit('extension', 'plan', 'failed', errorMetadata(error));
      throw error;
    }
  }

  public inspectPendingPlan(planId: string, ownerId: number): ExtensionInstallPlanView {
    this.#discardExpiredPlans();
    return pendingPlanView(planId, this.#ownedPendingPlan(planId, ownerId));
  }

  public denyApproval(planId: string, ownerId: number, reason: string): void {
    this.#discardExpiredPlans();
    this.#ownedPendingPlan(planId, ownerId);
    this.#plans.delete(planId);
    this.trustStore.appendAudit('extension', 'approve', 'denied', { reason });
  }

  public async approve(planId: string, ownerId: number): Promise<ExtensionDiscoveryView> {
    return this.#exclusiveMutation(() => this.#approve(planId, ownerId));
  }

  async #approve(planId: string, ownerId: number): Promise<ExtensionDiscoveryView> {
    this.#discardExpiredPlans();
    const pending = this.#ownedPendingPlan(planId, ownerId);

    this.#plans.delete(planId);
    const { plan, operation } = pending;
    const operationId = randomUUID();
    const approvedAt = this.now();
    let previousLedger: TrustedExtensionLedgerRecord | undefined;
    let staged = false;
    let registryMutated = false;
    try {
      previousLedger = await this.#validatePendingOperation(pending);
      this.trustStore.stageTrustedExtension({
        schemaVersion: plan.manifest.schemaVersion,
        extensionId: plan.manifest.id,
        extensionVersion: plan.manifest.version,
        manifestDigest: plan.manifestDigest,
        snapshotDigest: plan.snapshotDigest,
        permissions: [...plan.requestedPermissions].sort(),
        approvedAt: approvedAt.toISOString(),
        state: 'pending',
        operationId,
        updatedAt: approvedAt.toISOString(),
      });
      staged = true;
      const approval = createExtensionApproval(
        plan,
        {
          confirmed: true,
          permissions: plan.requestedPermissions,
        },
        approvedAt,
      );
      if (operation === 'install') {
        await this.service.install(plan, approval);
        registryMutated = true;
      } else {
        await this.service.update(plan.manifest.id, plan, approval);
        registryMutated = true;
      }
      this.trustStore.activateTrustedExtension(plan.manifest.id, operationId, this.now());
      this.#discardPlansForExtension(plan.manifest.id);
      this.trustStore.appendAudit('extension', operation, 'allowed', {
        extensionId: plan.manifest.id,
        version: plan.manifest.version,
        manifestDigest: plan.manifestDigest,
        snapshotDigest: plan.snapshotDigest,
        grantedPermissions: plan.requestedPermissions,
        operationId,
      });
      return await this.list();
    } catch (error) {
      let surfacedError = error;
      if (operation === 'update' && staged && !registryMutated && previousLedger !== undefined) {
        try {
          this.trustStore.restoreActiveTrustedExtension(previousLedger, operationId, this.now());
          this.trustStore.appendAudit('extension', 'update-ledger-rollback', 'allowed', {
            extensionId: plan.manifest.id,
            failedOperationId: operationId,
            restoredOperationId: previousLedger.operationId,
          });
        } catch (rollbackError) {
          surfacedError = new ExtensionRuntimeError(
            'REGISTRY_CORRUPT',
            'The extension update failed and its previous trusted approval could not be restored.',
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
      }
      if (operation === 'install' && staged && !registryMutated) {
        try {
          const current = this.trustStore.getTrustedExtension(plan.manifest.id);
          if (current?.state !== 'pending' || current.operationId !== operationId) {
            throw new Error('The failed install no longer owns its pending trusted state.');
          }
          const cleanupOperationId = randomUUID();
          this.trustStore.revokeTrustedExtension(plan.manifest.id, cleanupOperationId, this.now());
          this.trustStore.purgeTrustedExtension(plan.manifest.id, cleanupOperationId);
          this.trustStore.appendAudit('extension', 'install-ledger-cleanup', 'allowed', {
            extensionId: plan.manifest.id,
            failedOperationId: operationId,
          });
        } catch (cleanupError) {
          surfacedError = new ExtensionRuntimeError(
            'REGISTRY_CORRUPT',
            'The extension install failed and its pending trusted approval could not be removed.',
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
      }
      this.trustStore.appendAudit('extension', operation, 'failed', {
        extensionId: plan.manifest.id,
        version: plan.manifest.version,
        operationId,
        ...errorMetadata(surfacedError),
      });
      throw surfacedError;
    }
  }

  public async remove(extensionId: string, confirmation: string): Promise<ExtensionDiscoveryView> {
    return this.#exclusiveMutation(() => this.#remove(extensionId, confirmation));
  }

  async #remove(extensionId: string, confirmation: string): Promise<ExtensionDiscoveryView> {
    if (confirmation !== extensionId) {
      this.trustStore.appendAudit('extension', 'remove', 'denied', {
        extensionId,
        reason: 'The typed confirmation did not match the extension id.',
      });
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        `Type ${extensionId} exactly to remove this extension.`,
      );
    }
    const ledger = this.trustStore.getTrustedExtension(extensionId);
    if (ledger?.state !== 'active') {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        `Extension ${extensionId} is not active in the trusted extension ledger.`,
      );
    }
    const removalOperationId = randomUUID();
    try {
      this.trustStore.revokeTrustedExtension(extensionId, removalOperationId, this.now());
      const removed = await this.service.remove(extensionId);
      if (!removed) {
        throw new ExtensionRuntimeError(
          'NOT_INSTALLED',
          `Extension ${extensionId} is no longer installed. Refresh the list and try again.`,
        );
      }
      this.#discardPlansForExtension(extensionId);
      this.trustStore.appendAudit('extension', 'remove', 'allowed', {
        extensionId,
        operationId: removalOperationId,
      });
      return await this.list();
    } catch (error) {
      this.trustStore.appendAudit('extension', 'remove', 'failed', {
        extensionId,
        operationId: removalOperationId,
        ...errorMetadata(error),
      });
      throw error;
    }
  }

  public async purgeAll(): Promise<void> {
    return this.#exclusiveMutation(() => this.#purgeAll());
  }

  async #purgeAll(): Promise<void> {
    this.#plans.clear();
    const ledgers = this.trustStore.listTrustedExtensions();
    const revocations = ledgers.map((ledger) => {
      if (ledger.state === 'revoked') return ledger;
      return this.trustStore.revokeTrustedExtension(ledger.extensionId, randomUUID(), this.now());
    });
    await this.service.purgeAll();
    for (const ledger of revocations) {
      this.trustStore.purgeTrustedExtension(ledger.extensionId, ledger.operationId);
    }
    this.trustStore.appendAudit('extension', 'privacy-purge', 'allowed', {
      ledgerCount: ledgers.length,
    });
  }

  public discardOwner(ownerId: number): void {
    for (const [planId, pending] of this.#plans) {
      if (pending.ownerId === ownerId) this.#plans.delete(planId);
    }
  }

  public dispose(): void {
    this.#plans.clear();
  }

  #discardExpiredPlans(): void {
    const nowMs = this.now().getTime();
    for (const [planId, pending] of this.#plans) {
      if (pending.expiresAtMs <= nowMs) this.#plans.delete(planId);
    }
  }

  #ownedPendingPlan(planId: string, ownerId: number): PendingPlan {
    const pending = this.#plans.get(planId);
    if (pending === undefined || pending.ownerId !== ownerId) {
      this.trustStore.appendAudit('extension', 'approve', 'denied', {
        reason: 'The extension plan is missing, expired, or belongs to another window.',
      });
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        'This extension approval has expired. Select the extension again and review a fresh plan.',
      );
    }
    return pending;
  }

  async #discoverTrusted(): Promise<TrustedDiscovery> {
    const registry = await this.service.discover();
    const ledgers = this.trustStore.listTrustedExtensions();
    const ledgerById = new Map(ledgers.map((ledger) => [ledger.extensionId, ledger]));
    const registryIds = new Set<string>();
    const active: TrustedInstalledExtension[] = [];
    const quarantined: QuarantinedExtensionView[] = [];

    for (const extension of registry.installed) {
      const extensionId = extension.manifest.id;
      registryIds.add(extensionId);
      let ledger = ledgerById.get(extensionId);
      if (ledger?.state === 'pending' && trustedLedgerContentMismatch(extension, ledger) === null) {
        try {
          ledger = this.trustStore.activateTrustedExtension(
            extensionId,
            ledger.operationId,
            this.now(),
          );
          ledgerById.set(extensionId, ledger);
          this.trustStore.appendAudit('extension', 'recover-activation', 'allowed', {
            extensionId,
            operationId: ledger.operationId,
          });
        } catch (error) {
          this.trustStore.appendAudit('extension', 'recover-activation', 'failed', {
            extensionId,
            ...errorMetadata(error),
          });
        }
      }
      const mismatch = trustedLedgerMismatch(extension, ledger);
      if (mismatch === null && ledger !== undefined) {
        active.push({ extension, ledger });
        continue;
      }
      quarantined.push({
        extensionId,
        ledgerState: ledger?.state ?? 'missing',
        reason: mismatch ?? 'The trusted extension approval is unavailable.',
        snapshot: extensionSnapshotView(extension),
      });
    }

    for (const ledger of ledgers) {
      if (registryIds.has(ledger.extensionId)) continue;
      quarantined.push({
        extensionId: ledger.extensionId,
        ledgerState: ledger.state,
        reason:
          ledger.state === 'pending'
            ? 'An extension operation was interrupted before a matching registry snapshot became active.'
            : ledger.state === 'revoked'
              ? 'The extension trust was revoked and no registry snapshot is active.'
              : 'The active trusted ledger entry has no matching registry snapshot.',
      });
    }

    active.sort((left, right) =>
      left.extension.manifest.id.localeCompare(right.extension.manifest.id),
    );
    quarantined.sort((left, right) => left.extensionId.localeCompare(right.extensionId));
    return { active, quarantined, invalid: [...registry.invalid] };
  }

  #boundPendingPlans(ownerId: number): void {
    let ownerPlanCount = 0;
    for (const pending of this.#plans.values()) {
      if (pending.ownerId === ownerId) ownerPlanCount += 1;
    }
    for (const [planId, pending] of this.#plans) {
      if (ownerPlanCount <= MAX_PENDING_PLANS_PER_OWNER) return;
      if (pending.ownerId !== ownerId) continue;
      this.#plans.delete(planId);
      ownerPlanCount -= 1;
    }
  }

  #discardPlansForExtension(extensionId: string): void {
    for (const [planId, pending] of this.#plans) {
      if (pending.plan.manifest.id === extensionId) this.#plans.delete(planId);
    }
  }

  #exclusiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #validatePendingOperation(
    pending: PendingPlan,
  ): Promise<TrustedExtensionLedgerRecord | undefined> {
    const registry = await this.service.discover();
    if (registry.invalid.some((entry) => entry.entryName === pending.plan.manifest.id)) {
      throw new ExtensionRuntimeError(
        'REGISTRY_CORRUPT',
        `The ${pending.plan.manifest.id} registry entry became invalid after review.`,
      );
    }
    const existing = registry.installed.find(
      (extension) => extension.manifest.id === pending.plan.manifest.id,
    );
    if (pending.operation === 'install') {
      if (existing !== undefined) {
        throw new ExtensionRuntimeError(
          'ALREADY_INSTALLED',
          `Extension ${pending.plan.manifest.id} was installed after this plan was reviewed.`,
        );
      }
      const ledger = this.trustStore.getTrustedExtension(pending.plan.manifest.id);
      if (ledger !== undefined && ledger.state !== 'revoked') {
        throw new ExtensionRuntimeError(
          'APPROVAL_MISMATCH',
          `Extension ${pending.plan.manifest.id} already has ${ledger.state} trusted state.`,
        );
      }
      return undefined;
    }
    if (existing === undefined) {
      throw new ExtensionRuntimeError(
        'NOT_INSTALLED',
        `Extension ${pending.plan.manifest.id} is no longer installed.`,
      );
    }
    if (existing.manifest.version !== pending.currentVersion) {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        `Extension ${pending.plan.manifest.id} changed after this update plan was reviewed.`,
      );
    }
    if (compareSemanticVersions(pending.plan.manifest.version, existing.manifest.version) <= 0) {
      throw new ExtensionRuntimeError(
        'DOWNGRADE_DENIED',
        `Update version ${pending.plan.manifest.version} must be newer than ${existing.manifest.version}.`,
      );
    }
    const ledger = this.trustStore.getTrustedExtension(pending.plan.manifest.id);
    const mismatch = trustedLedgerMismatch(existing, ledger);
    if (mismatch !== null || ledger?.state !== 'active') {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        `The installed extension is not backed by its exact active approval: ${mismatch ?? 'approval unavailable'}`,
      );
    }
    return ledger;
  }
}

function errorMetadata(error: unknown): Record<string, unknown> {
  return {
    errorCode: error instanceof ExtensionRuntimeError ? error.code : 'OPERATION_FAILED',
    errorMessage: error instanceof Error ? error.message : 'Unknown extension operation failure.',
  };
}

function trustedLedgerMismatch(
  extension: InstalledExtension,
  ledger: TrustedExtensionLedgerRecord | undefined,
): string | null {
  if (ledger === undefined) {
    return 'The registry snapshot has no trusted extension ledger approval.';
  }
  if (ledger.state === 'pending') {
    return 'The extension install or update did not reach an active trusted state.';
  }
  if (ledger.state === 'revoked') {
    return 'The extension trust has been revoked.';
  }
  return trustedLedgerContentMismatch(extension, ledger);
}

function trustedLedgerContentMismatch(
  extension: InstalledExtension,
  ledger: TrustedExtensionLedgerRecord,
): string | null {
  const permissions = [...extension.record.grantedPermissions].sort();
  if (
    ledger.schemaVersion !== extension.manifest.schemaVersion ||
    ledger.extensionVersion !== extension.manifest.version ||
    ledger.manifestDigest !== extension.record.manifestDigest ||
    ledger.snapshotDigest !== extension.record.snapshotDigest ||
    JSON.stringify(ledger.permissions) !== JSON.stringify(permissions)
  ) {
    return 'The active ledger does not exactly match this API version, version, digest, or permission set.';
  }
  return null;
}

function extensionSnapshotView(extension: InstalledExtension) {
  return {
    record: extension.record,
    manifest: manifestView(extension.manifest),
    manifestJson: JSON.stringify(extension.manifest, null, 2),
    ...(extension.documentationText === undefined
      ? {}
      : { documentationText: extension.documentationText }),
  };
}

function activeExtensionView(
  extension: InstalledExtension,
  ledger: TrustedExtensionLedgerRecord,
): InstalledExtensionView {
  return {
    ...extensionSnapshotView(extension),
    trustState: 'active',
    approvedAt: ledger.approvedAt,
  };
}

function pendingPlanView(planId: string, pending: PendingPlan): ExtensionInstallPlanView {
  const { plan } = pending;
  return ExtensionInstallPlanViewSchema.parse({
    planId,
    operation: pending.operation,
    currentVersion: pending.currentVersion,
    manifest: manifestView(plan.manifest),
    manifestJson: JSON.stringify(plan.manifest, null, 2),
    manifestDigest: plan.manifestDigest,
    snapshotDigest: plan.snapshotDigest,
    sourcePath: plan.sourcePath,
    requestedPermissions: plan.requestedPermissions,
    ...(plan.documentationText === undefined ? {} : { documentationText: plan.documentationText }),
    expiresAt: new Date(pending.expiresAtMs).toISOString(),
  });
}

function manifestView(manifest: ExtensionManifest): ExtensionManifestView {
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    publisher: manifest.publisher,
    requestedPermissions: manifest.requestedPermissions,
    ...(manifest.documentationFile === undefined
      ? {}
      : { documentationFile: manifest.documentationFile }),
    contributes: {
      agentAdapters: manifest.contributes.agentAdapters.map((adapter) => ({
        id: adapter.id,
        name: adapter.name,
        providerName: adapter.provider.name,
        providerDisclosure: adapter.provider.disclosure,
        sendsContextOffDevice: adapter.provider.sendsContextOffDevice,
        executable: adapter.executable.command,
        permissionModes: adapter.capabilities.permissionModes,
      })),
      canvasNodeTypes: manifest.contributes.canvasNodeTypes.map((nodeType) => ({
        id: nodeType.id,
        displayName: nodeType.displayName,
        description: nodeType.description,
        category: nodeType.category,
        icon: nodeType.icon,
        color: nodeType.color,
        capabilities: nodeType.capabilities,
        fields: nodeType.fields,
        ports: nodeType.ports,
      })),
    },
  };
}
