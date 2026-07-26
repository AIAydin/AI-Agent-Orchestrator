import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { isPathContained, resolveCanonicalPath } from '@forgeboard/core';
import type { z } from 'zod';

import {
  EXTENSION_API_VERSION,
  EXTENSION_MANIFEST_FILENAME,
  ExtensionApprovalSchema,
  ExtensionManifestSchema,
  InstalledExtensionRecordSchema,
  SemanticVersionSchema,
  requiredPermissionsForManifest,
  type ExtensionApproval,
  type ExtensionManifest,
  type ExtensionPermission,
  type InstalledExtensionRecord,
} from './schema.js';

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_DOCUMENTATION_BYTES = 262_144;
const INSTALLED_MANIFEST_FILENAME = 'manifest.json';
const INSTALL_RECORD_FILENAME = 'install-record.json';
const DOCUMENTATION_FILENAME = 'documentation.txt';
const SNAPSHOT_DIGEST_DOMAIN = 'forgeboard-extension-snapshot-v1';

export const EXTENSION_APPROVAL_MAX_AGE_MS = 15 * 60 * 1_000;
export const EXTENSION_APPROVAL_MAX_FUTURE_SKEW_MS = 60 * 1_000;

export type ExtensionRuntimeErrorCode =
  | 'APPROVAL_MISMATCH'
  | 'ALREADY_INSTALLED'
  | 'DOWNGRADE_DENIED'
  | 'INVALID_MANIFEST'
  | 'INVALID_SELECTION'
  | 'NOT_INSTALLED'
  | 'PATH_ESCAPE'
  | 'REGISTRY_CORRUPT'
  | 'RESOURCE_INVALID';

export class ExtensionRuntimeError extends Error {
  public constructor(
    public readonly code: ExtensionRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExtensionRuntimeError';
  }
}

export interface ExtensionInstallPlan {
  readonly manifest: ExtensionManifest;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
  readonly sourcePath: string;
  readonly manifestPath: string;
  readonly requestedPermissions: readonly ExtensionPermission[];
  readonly documentationText?: string;
}

export interface InstalledExtension {
  readonly record: InstalledExtensionRecord;
  readonly manifest: ExtensionManifest;
  readonly documentationText?: string;
}

export interface InvalidInstalledExtension {
  readonly entryName: string;
  readonly reason: string;
}

export interface ExtensionDiscoveryResult {
  readonly installed: readonly InstalledExtension[];
  readonly invalid: readonly InvalidInstalledExtension[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestManifest(manifest: ExtensionManifest): string {
  return sha256(JSON.stringify(manifest));
}

function digestSnapshot(
  manifest: ExtensionManifest,
  documentationText: string | undefined,
): string {
  return sha256(
    JSON.stringify({
      domain: SNAPSHOT_DIGEST_DOMAIN,
      manifest,
      documentationText: documentationText ?? null,
    }),
  );
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

async function readBoundedUtf8(filePath: string, maximumBytes: number): Promise<string> {
  const details = await stat(filePath);
  if (!details.isFile()) {
    throw new ExtensionRuntimeError('RESOURCE_INVALID', `Expected a regular file: ${filePath}`);
  }
  if (details.size > maximumBytes) {
    throw new ExtensionRuntimeError(
      'RESOURCE_INVALID',
      `File exceeds the ${String(maximumBytes)} byte limit: ${filePath}`,
    );
  }

  // O_NOFOLLOW prevents a final-component symlink race on platforms that provide it. Canonical
  // containment is also checked by callers and remains the cross-platform policy boundary.
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    throw new ExtensionRuntimeError('RESOURCE_INVALID', `Cannot safely open: ${filePath}`, {
      cause: error,
    });
  }
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) {
      throw new ExtensionRuntimeError(
        'RESOURCE_INVALID',
        `File exceeds the ${String(maximumBytes)} byte limit: ${filePath}`,
      );
    }
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function assertNotSymlink(candidatePath: string, label: string): Promise<void> {
  const details = await lstat(candidatePath);
  if (details.isSymbolicLink()) {
    throw new ExtensionRuntimeError(
      'PATH_ESCAPE',
      `${label} cannot be a symbolic link: ${candidatePath}`,
    );
  }
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

function parseSemanticVersion(version: string): {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
} {
  const parsedVersion = SemanticVersionSchema.parse(version);
  const buildIndex = parsedVersion.indexOf('+');
  const withoutBuild = buildIndex === -1 ? parsedVersion : parsedVersion.slice(0, buildIndex);
  const prereleaseIndex = withoutBuild.indexOf('-');
  const corePart = prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex);
  const prereleasePart =
    prereleaseIndex === -1 ? undefined : withoutBuild.slice(prereleaseIndex + 1);
  const coreSegments = corePart.split('.').map(BigInt);
  return {
    core: [coreSegments[0] ?? 0n, coreSegments[1] ?? 0n, coreSegments[2] ?? 0n],
    prerelease: prereleasePart === undefined ? [] : prereleasePart.split('.'),
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  // SemVer precedence is ASCII lexical ordering. Locale collation can fold or reorder case.
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftVersion.core[index] ?? 0n;
    const rightPart = rightVersion.core[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) return 0;
  if (leftVersion.prerelease.length === 0) return 1;
  if (rightVersion.prerelease.length === 0) return -1;
  const count = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const difference = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function createExtensionApproval(
  plan: ExtensionInstallPlan,
  decision: { readonly confirmed: true; readonly permissions: readonly ExtensionPermission[] },
  approvedAt = new Date(),
): ExtensionApproval {
  return {
    extensionId: plan.manifest.id,
    version: plan.manifest.version,
    manifestDigest: plan.manifestDigest,
    snapshotDigest: plan.snapshotDigest,
    permissions: [...decision.permissions],
    confirmed: decision.confirmed,
    approvedAt: approvedAt.toISOString(),
  };
}

export class LocalExtensionService {
  readonly #registryRoot: string;
  #operationTail: Promise<void> = Promise.resolve();

  public constructor(
    registryRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!path.isAbsolute(registryRoot) || registryRoot.includes('\0')) {
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        'The extension registry root must be an absolute ordinary path.',
      );
    }
    this.#registryRoot = path.resolve(registryRoot);
  }

  public get registryRoot(): string {
    return this.#registryRoot;
  }

  public async planFromSelectedPath(selectedPath: string): Promise<ExtensionInstallPlan> {
    if (!path.isAbsolute(selectedPath) || selectedPath.includes('\0')) {
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        'The user-selected extension path must be absolute.',
      );
    }

    let selectedDetails;
    try {
      selectedDetails = await lstat(selectedPath);
    } catch (error) {
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        `The selected extension path does not exist: ${selectedPath}`,
        { cause: error },
      );
    }
    if (selectedDetails.isSymbolicLink()) {
      throw new ExtensionRuntimeError(
        'PATH_ESCAPE',
        'Select the actual extension folder or manifest, not a symbolic link.',
      );
    }

    let sourcePath: string;
    let manifestPath: string;
    if (selectedDetails.isDirectory()) {
      sourcePath = await realpath(selectedPath);
      manifestPath = path.join(sourcePath, EXTENSION_MANIFEST_FILENAME);
    } else if (
      selectedDetails.isFile() &&
      path.basename(selectedPath) === EXTENSION_MANIFEST_FILENAME
    ) {
      manifestPath = await realpath(selectedPath);
      sourcePath = await realpath(path.dirname(selectedPath));
    } else {
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        `Select a folder containing ${EXTENSION_MANIFEST_FILENAME} or that manifest itself.`,
      );
    }

    if (!isPathContained(sourcePath, manifestPath)) {
      throw new ExtensionRuntimeError('PATH_ESCAPE', 'The extension manifest escapes its folder.');
    }
    try {
      await assertNotSymlink(manifestPath, 'The extension manifest');
    } catch (error) {
      if (error instanceof ExtensionRuntimeError) throw error;
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        `Missing ${EXTENSION_MANIFEST_FILENAME} in ${sourcePath}.`,
        { cause: error },
      );
    }

    let rawManifest: string;
    try {
      rawManifest = await readBoundedUtf8(manifestPath, MAX_MANIFEST_BYTES);
    } catch (error) {
      if (error instanceof ExtensionRuntimeError) throw error;
      throw new ExtensionRuntimeError('INVALID_MANIFEST', 'Unable to read extension manifest.', {
        cause: error,
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawManifest) as unknown;
    } catch (error) {
      throw new ExtensionRuntimeError('INVALID_MANIFEST', 'Extension manifest is not valid JSON.', {
        cause: error,
      });
    }

    const result = ExtensionManifestSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new ExtensionRuntimeError(
        'INVALID_MANIFEST',
        `Extension manifest validation failed: ${formatValidationError(result.error)}`,
        { cause: result.error },
      );
    }

    let documentationText: string | undefined;
    if (result.data.documentationFile !== undefined) {
      let documentationPath;
      try {
        documentationPath = await resolveCanonicalPath(sourcePath, result.data.documentationFile, {
          mustExist: true,
        });
      } catch (error) {
        throw new ExtensionRuntimeError(
          'PATH_ESCAPE',
          'The extension documentation path is missing or escapes the selected extension folder.',
          { cause: error },
        );
      }
      documentationText = await readBoundedUtf8(documentationPath.path, MAX_DOCUMENTATION_BYTES);
    }

    const snapshotDigest = digestSnapshot(result.data, documentationText);
    return {
      manifest: result.data,
      manifestDigest: digestManifest(result.data),
      snapshotDigest,
      sourcePath,
      manifestPath,
      requestedPermissions: requiredPermissionsForManifest(result.data),
      ...(documentationText === undefined ? {} : { documentationText }),
    };
  }

  public async install(
    plan: ExtensionInstallPlan,
    approval: ExtensionApproval,
  ): Promise<InstalledExtension> {
    return this.#exclusive(async () => {
      this.#assertApproval(plan, approval);
      const root = await this.#ensureRegistryRoot();
      const destination = this.#extensionPath(root, plan.manifest.id);
      try {
        await lstat(destination);
        throw new ExtensionRuntimeError(
          'ALREADY_INSTALLED',
          `Extension ${plan.manifest.id} is already installed.`,
        );
      } catch (error) {
        if (error instanceof ExtensionRuntimeError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const now = this.now().toISOString();
      const record: InstalledExtensionRecord = {
        schemaVersion: EXTENSION_API_VERSION,
        extensionId: plan.manifest.id,
        version: plan.manifest.version,
        manifestDigest: plan.manifestDigest,
        snapshotDigest: plan.snapshotDigest,
        grantedPermissions: sortedUnique(approval.permissions),
        sourcePath: plan.sourcePath,
        installedAt: now,
        updatedAt: now,
      };
      await this.#writeSnapshot(root, destination, plan, record);
      return {
        record,
        manifest: plan.manifest,
        ...(plan.documentationText === undefined
          ? {}
          : { documentationText: plan.documentationText }),
      };
    });
  }

  public async update(
    extensionId: string,
    plan: ExtensionInstallPlan,
    approval: ExtensionApproval,
  ): Promise<InstalledExtension> {
    return this.#exclusive(async () => {
      this.#assertApproval(plan, approval);
      if (plan.manifest.id !== extensionId) {
        throw new ExtensionRuntimeError(
          'INVALID_MANIFEST',
          `Update id ${plan.manifest.id} does not match installed extension ${extensionId}.`,
        );
      }

      const root = await this.#ensureRegistryRoot();
      const existing = await this.#readInstalled(root, extensionId);
      if (existing === undefined) {
        throw new ExtensionRuntimeError(
          'NOT_INSTALLED',
          `Extension ${extensionId} is not installed.`,
        );
      }
      if (compareSemanticVersions(plan.manifest.version, existing.manifest.version) <= 0) {
        throw new ExtensionRuntimeError(
          'DOWNGRADE_DENIED',
          `Update version ${plan.manifest.version} must be newer than ${existing.manifest.version}.`,
        );
      }

      const destination = this.#extensionPath(root, extensionId);
      await assertNotSymlink(destination, 'An installed extension directory');
      const record: InstalledExtensionRecord = {
        schemaVersion: EXTENSION_API_VERSION,
        extensionId,
        version: plan.manifest.version,
        manifestDigest: plan.manifestDigest,
        snapshotDigest: plan.snapshotDigest,
        grantedPermissions: sortedUnique(approval.permissions),
        sourcePath: plan.sourcePath,
        installedAt: existing.record.installedAt,
        updatedAt: this.now().toISOString(),
      };
      await this.#writeSnapshot(root, destination, plan, record, true);
      return {
        record,
        manifest: plan.manifest,
        ...(plan.documentationText === undefined
          ? {}
          : { documentationText: plan.documentationText }),
      };
    });
  }

  public async remove(extensionId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const root = await this.#ensureRegistryRoot();
      const destination = this.#extensionPath(root, extensionId);
      try {
        await assertNotSymlink(destination, 'An installed extension directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      const tombstone = this.#extensionPath(root, `.removing-${randomUUID()}`);
      await rename(destination, tombstone);
      await rm(tombstone, { recursive: true, force: true });
      return true;
    });
  }

  /** Removes every managed registry snapshot without following extension-owned links. */
  public async purgeAll(): Promise<void> {
    return this.#exclusive(async () => {
      const root = await this.#ensureRegistryRoot();
      const tombstone = path.join(
        path.dirname(root),
        `.${path.basename(root)}.purging-${randomUUID()}`,
      );
      await rename(root, tombstone);
      try {
        await rm(tombstone, { recursive: true, force: true });
      } catch (error) {
        await rename(tombstone, root).catch(() => undefined);
        throw new ExtensionRuntimeError(
          'RESOURCE_INVALID',
          'Artemis could not safely purge the managed extension registry.',
          { cause: error },
        );
      }
      await mkdir(this.#registryRoot, { recursive: true, mode: 0o700 });
    });
  }

  public async discover(): Promise<ExtensionDiscoveryResult> {
    const root = await this.#ensureRegistryRoot();
    const installed: InstalledExtension[] = [];
    const invalid: InvalidInstalledExtension[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        invalid.push({ entryName: entry.name, reason: 'Registry entry is not a plain directory.' });
        continue;
      }
      try {
        const extension = await this.#readInstalled(root, entry.name);
        if (extension === undefined) {
          invalid.push({ entryName: entry.name, reason: 'Registry entry disappeared.' });
        } else {
          installed.push(extension);
        }
      } catch (error) {
        invalid.push({
          entryName: entry.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    installed.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
    invalid.sort((left, right) => left.entryName.localeCompare(right.entryName));
    return { installed, invalid };
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertApproval(plan: ExtensionInstallPlan, input: ExtensionApproval): void {
    const manifestResult = ExtensionManifestSchema.safeParse(plan.manifest);
    const approvalResult = ExtensionApprovalSchema.safeParse(input);
    if (!manifestResult.success || !approvalResult.success) {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        'The install plan or approval is malformed.',
      );
    }
    const approval = approvalResult.data;
    const approvedAtMs = Date.parse(approval.approvedAt);
    const nowMs = this.now().getTime();
    if (approvedAtMs < nowMs - EXTENSION_APPROVAL_MAX_AGE_MS) {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        'Approval is stale. Review and approve a fresh plan.',
      );
    }
    if (approvedAtMs > nowMs + EXTENSION_APPROVAL_MAX_FUTURE_SKEW_MS) {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        'Approval timestamp is too far in the future. Review and approve a fresh plan.',
      );
    }
    const canonicalManifest = JSON.stringify(manifestResult.data);
    if (
      Buffer.byteLength(canonicalManifest, 'utf8') > MAX_MANIFEST_BYTES ||
      (plan.documentationText !== undefined &&
        Buffer.byteLength(plan.documentationText, 'utf8') > MAX_DOCUMENTATION_BYTES)
    ) {
      throw new ExtensionRuntimeError(
        'INVALID_MANIFEST',
        'The install plan exceeds the bounded manifest or documentation size.',
      );
    }
    const expectedPermissions = sortedUnique(requiredPermissionsForManifest(manifestResult.data));
    const approvedPermissions = sortedUnique(approval.permissions);
    const matches =
      approval.extensionId === manifestResult.data.id &&
      approval.version === manifestResult.data.version &&
      plan.manifestDigest === sha256(canonicalManifest) &&
      approval.manifestDigest === plan.manifestDigest &&
      plan.snapshotDigest === digestSnapshot(manifestResult.data, plan.documentationText) &&
      approval.snapshotDigest === plan.snapshotDigest &&
      JSON.stringify(approvedPermissions) === JSON.stringify(expectedPermissions) &&
      JSON.stringify(sortedUnique(plan.requestedPermissions)) ===
        JSON.stringify(expectedPermissions);
    if (!matches) {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        'Approval must match the exact extension id, version, snapshot digest, and permissions.',
      );
    }
  }

  async #ensureRegistryRoot(): Promise<string> {
    try {
      const existing = await lstat(this.#registryRoot);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new ExtensionRuntimeError(
          'REGISTRY_CORRUPT',
          'The extension registry root must be a plain directory, not a symlink.',
        );
      }
    } catch (error) {
      if (error instanceof ExtensionRuntimeError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(this.#registryRoot, { recursive: true, mode: 0o700 });
    }
    return realpath(this.#registryRoot);
  }

  #extensionPath(root: string, extensionId: string): string {
    if (extensionId.length > 128 || !/^\.?[a-z0-9][a-z0-9._-]*$/u.test(extensionId)) {
      throw new ExtensionRuntimeError('PATH_ESCAPE', 'Unsafe extension registry entry id.');
    }
    const candidate = path.join(root, extensionId);
    if (!isPathContained(root, candidate) || candidate === root) {
      throw new ExtensionRuntimeError('PATH_ESCAPE', 'Extension path escapes the registry root.');
    }
    return candidate;
  }

  async #writeSnapshot(
    root: string,
    destination: string,
    plan: ExtensionInstallPlan,
    record: InstalledExtensionRecord,
    replace = false,
  ): Promise<void> {
    const stage = this.#extensionPath(root, `.staging-${randomUUID()}`);
    const backup = this.#extensionPath(root, `.backup-${randomUUID()}`);
    let removeBackup = false;
    let destinationCommitted = false;
    await mkdir(stage, { mode: 0o700 });
    try {
      await writeFile(
        path.join(stage, INSTALLED_MANIFEST_FILENAME),
        `${JSON.stringify(plan.manifest, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      await writeFile(
        path.join(stage, INSTALL_RECORD_FILENAME),
        `${JSON.stringify(record, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      if (plan.documentationText !== undefined) {
        await writeFile(path.join(stage, DOCUMENTATION_FILENAME), plan.documentationText, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      }

      if (!replace) {
        await rename(stage, destination);
        destinationCommitted = true;
        return;
      }

      await rename(destination, backup);
      try {
        await rename(stage, destination);
        destinationCommitted = true;
      } catch (error) {
        try {
          await rename(backup, destination);
        } catch (restoreError) {
          throw new ExtensionRuntimeError(
            'REGISTRY_CORRUPT',
            `Extension update failed and its backup remains at ${backup}.`,
            { cause: new AggregateError([error, restoreError]) },
          );
        }
        throw error;
      }
      removeBackup = true;
      // Once the staged snapshot becomes the destination, the update is committed. A cleanup
      // error must not report the update as failed: doing so could make the trust ledger roll
      // back to the old digest while the new registry snapshot is already live. Hidden backups
      // are never discovered and a later purge removes them.
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      removeBackup = false;
    } finally {
      const removeStage = rm(stage, { recursive: true, force: true });
      if (destinationCommitted) await removeStage.catch(() => undefined);
      else await removeStage;
      if (removeBackup) {
        await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #readInstalled(root: string, extensionId: string): Promise<InstalledExtension | undefined> {
    const extensionPath = this.#extensionPath(root, extensionId);
    try {
      await assertNotSymlink(extensionPath, 'An installed extension directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const canonicalExtensionPath = await realpath(extensionPath);
    if (!isPathContained(root, canonicalExtensionPath) || canonicalExtensionPath === root) {
      throw new ExtensionRuntimeError('PATH_ESCAPE', 'Installed extension escapes the registry.');
    }

    const manifestPath = path.join(canonicalExtensionPath, INSTALLED_MANIFEST_FILENAME);
    const recordPath = path.join(canonicalExtensionPath, INSTALL_RECORD_FILENAME);
    await assertNotSymlink(manifestPath, 'An installed manifest');
    await assertNotSymlink(recordPath, 'An install record');
    const [manifestText, recordText] = await Promise.all([
      readBoundedUtf8(manifestPath, MAX_MANIFEST_BYTES),
      readBoundedUtf8(recordPath, MAX_MANIFEST_BYTES),
    ]);

    let manifestJson: unknown;
    let recordJson: unknown;
    try {
      manifestJson = JSON.parse(manifestText) as unknown;
      recordJson = JSON.parse(recordText) as unknown;
    } catch (error) {
      throw new ExtensionRuntimeError(
        'REGISTRY_CORRUPT',
        'Installed extension JSON is malformed.',
        {
          cause: error,
        },
      );
    }
    const manifest = ExtensionManifestSchema.safeParse(manifestJson);
    const record = InstalledExtensionRecordSchema.safeParse(recordJson);
    if (!manifest.success || !record.success) {
      throw new ExtensionRuntimeError(
        'REGISTRY_CORRUPT',
        'Installed extension manifest or record failed validation.',
      );
    }
    let documentationText: string | undefined;
    if (manifest.data.documentationFile !== undefined) {
      const documentationPath = path.join(canonicalExtensionPath, DOCUMENTATION_FILENAME);
      await assertNotSymlink(documentationPath, 'Installed extension documentation');
      documentationText = await readBoundedUtf8(documentationPath, MAX_DOCUMENTATION_BYTES);
    }
    if (
      manifest.data.id !== extensionId ||
      record.data.extensionId !== extensionId ||
      manifest.data.version !== record.data.version ||
      digestManifest(manifest.data) !== record.data.manifestDigest ||
      digestSnapshot(manifest.data, documentationText) !== record.data.snapshotDigest ||
      JSON.stringify(sortedUnique(record.data.grantedPermissions)) !==
        JSON.stringify(requiredPermissionsForManifest(manifest.data))
    ) {
      throw new ExtensionRuntimeError(
        'REGISTRY_CORRUPT',
        'Installed extension identity, version, or snapshot digest does not match its record.',
      );
    }
    return {
      record: record.data,
      manifest: manifest.data,
      ...(documentationText === undefined ? {} : { documentationText }),
    };
  }
}
