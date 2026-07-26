import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  windowsFilesystemSecurity,
  type WindowsFilesystemSecurity,
} from '../../../security/windows/filesystem-acl.js';

const STORE_DIRECTORY_NAME = '.forgeboard-agent-context-v1';
const ROOT_MARKER_NAME = 'root.json';
const INSTANCE_MARKER_NAME = 'instance.json';
const INSTANCE_PREFIX = 'instance-';
const SNAPSHOT_PREFIX = 'snapshot-';
const QUARANTINE_PREFIX = 'stale-';
const MARKER_MAX_BYTES = 4_096;
const MARKER_VERSION = 1;
const MARKER_FORMAT = 'forgeboard-agent-context';
const DEFAULT_LIVE_MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type SnapshotStoreScope = 'host' | 'managed';

interface RootMarker {
  readonly format: typeof MARKER_FORMAT;
  readonly version: typeof MARKER_VERSION;
  readonly kind: 'root';
  readonly scope: SnapshotStoreScope;
  readonly basePath: string;
  readonly windowsSid?: string;
}

interface InstanceMarker {
  readonly format: typeof MARKER_FORMAT;
  readonly version: typeof MARKER_VERSION;
  readonly kind: 'instance';
  readonly instanceId: string;
  readonly parentPath: string;
  readonly pid: number;
  readonly uid?: number;
  readonly windowsSid?: string;
  readonly createdAt: string;
}

interface ParentState {
  readonly parentPath: string;
  readonly parentIdentity: Stats;
  readonly rootMarker: RootMarker;
  readonly instancePath: string;
  readonly instanceIdentity: Stats;
  readonly instanceMarker: InstanceMarker;
}

export interface ContextSnapshotDirectoryLease {
  readonly rootPath: string;
  protectFile(filePath: string): Promise<void>;
  revalidate(filePaths: readonly string[]): Promise<void>;
  cleanup(): Promise<void>;
}

export type ContextSnapshotStorageRequest =
  | { readonly runtime: 'host' }
  | {
      readonly runtime: 'docker';
      readonly managedRoot: string;
      readonly checkoutPath: string;
    };

interface ContextSnapshotStorageManagerOptions {
  readonly hostBasePath?: string;
  readonly pid?: number;
  readonly uid?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly liveMarkerMaxAgeMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly windowsSecurity?: WindowsFilesystemSecurity;
}

interface StorageOwner {
  readonly platform: NodeJS.Platform;
  readonly uid?: number;
  readonly windowsSid?: string;
  readonly windowsSecurity?: WindowsFilesystemSecurity;
}

/**
 * Owns private snapshot directories without ever scanning arbitrary worktree folders. A process
 * writes one marker-bound instance directory per parent; fresh processes remove only fully
 * validated prior instances. Production initializes the singleton only after Electron acquires its
 * single-instance lock, and this manager initializes each parent once before creating its own UUID,
 * so no live Artemis instance can be among the children it scavenges.
 */
export class ContextSnapshotStorageManager {
  readonly #hostBasePath: string;
  readonly #pid: number;
  readonly #platform: NodeJS.Platform;
  readonly #uid: number | undefined;
  readonly #windowsSecurity: WindowsFilesystemSecurity | undefined;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #liveMarkerMaxAgeMs: number;
  readonly #parents = new Map<string, Promise<ParentState>>();
  readonly #ownedInstancePaths = new Set<string>();
  #hostBasePromise: Promise<string> | undefined;
  #ownerPromise: Promise<StorageOwner> | undefined;

  public constructor(options: ContextSnapshotStorageManagerOptions = {}) {
    this.#hostBasePath = options.hostBasePath ?? tmpdir();
    this.#pid = options.pid ?? process.pid;
    this.#platform = options.platform ?? process.platform;
    this.#uid = this.#platform === 'win32' ? undefined : (options.uid ?? currentUid());
    this.#windowsSecurity =
      this.#platform === 'win32'
        ? (options.windowsSecurity ?? windowsFilesystemSecurity)
        : undefined;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.#liveMarkerMaxAgeMs = options.liveMarkerMaxAgeMs ?? DEFAULT_LIVE_MARKER_MAX_AGE_MS;
    if (!Number.isSafeInteger(this.#pid) || this.#pid <= 0) {
      throw new Error('Context snapshot storage requires a valid process identity.');
    }
    if (!Number.isSafeInteger(this.#liveMarkerMaxAgeMs) || this.#liveMarkerMaxAgeMs < 1) {
      throw new Error('Context snapshot storage requires a bounded live-marker age.');
    }
  }

  public async initializeHost(): Promise<void> {
    await this.#parent('host', await this.#hostBase());
  }

  public async createSnapshotDirectory(
    request: ContextSnapshotStorageRequest,
  ): Promise<ContextSnapshotDirectoryLease> {
    const parent =
      request.runtime === 'host'
        ? await this.#parent('host', await this.#hostBase())
        : await this.#managedParent(request.managedRoot, request.checkoutPath);
    const owner = await this.#owner();
    await this.#revalidateParentState(parent, owner);
    const snapshotId = validId(this.#createId());
    const rootPath = path.join(parent.instancePath, `${SNAPSHOT_PREFIX}${snapshotId}`);
    await mkdir(rootPath, { mode: 0o700 });
    const identity = await protectCreatedPrivateDirectory(
      rootPath,
      parent.instancePath,
      owner,
      0o500,
    );
    const revalidateRoot = async (): Promise<StorageOwner> => {
      const currentOwner = await this.#owner();
      await this.#revalidateParentState(parent, currentOwner);
      const currentRoot = await validatePrivateDirectory(
        rootPath,
        parent.instancePath,
        currentOwner,
        0o500,
      );
      if (!sameIdentity(identity, currentRoot)) {
        throw new Error('The private context snapshot directory changed before launch.');
      }
      return currentOwner;
    };
    let cleaned = false;
    let cleanupInFlight: Promise<void> | undefined;
    const remove = async (): Promise<void> => {
      if (cleaned) return;
      const current = await lstat(rootPath).catch((error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw error;
      });
      if (current === undefined) {
        cleaned = true;
        return;
      }
      if (!sameIdentity(identity, current)) {
        throw new Error('The private context snapshot directory changed before cleanup.');
      }
      await validatePrivateDirectory(rootPath, parent.instancePath, owner, 0o500);
      if (this.#platform !== 'win32') await chmod(rootPath, 0o700);
      await rm(rootPath, { recursive: true, force: false });
      cleaned = true;
    };
    return {
      rootPath,
      protectFile: async (filePath) => {
        const currentOwner = await revalidateRoot();
        const before = await validateSnapshotFileShape(filePath, rootPath, currentOwner);
        if (currentOwner.windowsSid !== undefined && currentOwner.windowsSecurity !== undefined) {
          await currentOwner.windowsSecurity.protectPrivateFile(filePath, currentOwner.windowsSid);
        } else {
          await chmod(filePath, 0o400);
        }
        const after = await validateSnapshotFileShape(filePath, rootPath, currentOwner);
        if (!sameIdentity(before, after)) {
          throw new Error(
            'A private context snapshot file changed while its permissions were applied.',
          );
        }
        await validatePrivateSnapshotFile(filePath, rootPath, currentOwner);
      },
      revalidate: async (filePaths) => {
        const currentOwner = await revalidateRoot();
        const uniquePaths = new Set(filePaths.map((filePath) => path.resolve(filePath)));
        if (uniquePaths.size !== filePaths.length) {
          throw new Error('The private context snapshot contains duplicate file paths.');
        }
        for (const filePath of uniquePaths) {
          await validatePrivateSnapshotFile(filePath, rootPath, currentOwner);
        }
      },
      cleanup: async () => {
        if (cleaned) return;
        cleanupInFlight ??= remove();
        try {
          await cleanupInFlight;
        } finally {
          if (!cleaned) cleanupInFlight = undefined;
        }
      },
    };
  }

  async #managedParent(managedRootInput: string, checkoutInput: string): Promise<ParentState> {
    const [managedRoot, checkout] = await Promise.all([
      canonicalBase(managedRootInput),
      realpath(path.resolve(checkoutInput)),
    ]);
    if (!isContainedPath(managedRoot, checkout) || pathsEqual(managedRoot, checkout)) {
      throw new Error('The Docker checkout is outside its authoritative managed-worktree root.');
    }
    const owner = await this.#owner();
    if (owner.windowsSid !== undefined && owner.windowsSecurity !== undefined) {
      await owner.windowsSecurity.assertSafeParent(managedRoot, owner.windowsSid);
      return await this.#parent('managed', await this.#hostBase());
    }
    return await this.#parent('managed', managedRoot);
  }

  async #parent(scope: SnapshotStoreScope, canonicalBasePath: string): Promise<ParentState> {
    const key = `${scope}\0${canonicalBasePath}`;
    const existing = this.#parents.get(key);
    if (existing !== undefined) return await existing;
    const creating = this.#initializeParent(scope, canonicalBasePath);
    this.#parents.set(key, creating);
    try {
      return await creating;
    } catch (error) {
      if (this.#parents.get(key) === creating) this.#parents.delete(key);
      throw error;
    }
  }

  async #initializeParent(
    scope: SnapshotStoreScope,
    canonicalBasePath: string,
  ): Promise<ParentState> {
    const owner = await this.#owner();
    if (owner.windowsSid !== undefined && owner.windowsSecurity !== undefined) {
      await owner.windowsSecurity.assertSafeParent(canonicalBasePath, owner.windowsSid);
    }
    const parentPath = path.join(canonicalBasePath, privateParentName(scope, owner));
    let created = false;
    try {
      await mkdir(parentPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const parentIdentity = created
      ? await protectCreatedPrivateDirectory(parentPath, canonicalBasePath, owner)
      : await validatePrivateDirectory(parentPath, canonicalBasePath, owner);
    const expectedRootMarker: RootMarker = {
      format: MARKER_FORMAT,
      version: MARKER_VERSION,
      kind: 'root',
      scope,
      basePath: canonicalBasePath,
      ...(owner.windowsSid === undefined ? {} : { windowsSid: owner.windowsSid }),
    };
    const markerPath = path.join(parentPath, ROOT_MARKER_NAME);
    if (created) {
      await writeExclusiveMarker(markerPath, expectedRootMarker);
    } else if (!(await pathExists(markerPath))) {
      const entries = await readdir(parentPath);
      if (entries.length !== 0) {
        throw new Error('The private context snapshot parent is missing its ownership marker.');
      }
      try {
        await writeExclusiveMarker(markerPath, expectedRootMarker);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
    }
    const rootMarker = parseRootMarker(await readValidatedMarker(markerPath, parentPath, owner));
    if (!rootMarkersEqual(rootMarker, expectedRootMarker)) {
      throw new Error('The private context snapshot parent marker does not match this location.');
    }
    await this.#scavengeStaleInstances(parentPath);
    return await this.#createInstance(parentPath, parentIdentity, rootMarker);
  }

  async #createInstance(
    parentPath: string,
    parentIdentity: Stats,
    rootMarker: RootMarker,
  ): Promise<ParentState> {
    const owner = await this.#owner();
    const instanceId = validId(this.#createId());
    const instancePath = path.join(parentPath, `${INSTANCE_PREFIX}${instanceId}`);
    await mkdir(instancePath, { mode: 0o700 });
    const instanceIdentity = await protectCreatedPrivateDirectory(instancePath, parentPath, owner);
    const marker: InstanceMarker = {
      format: MARKER_FORMAT,
      version: MARKER_VERSION,
      kind: 'instance',
      instanceId,
      parentPath,
      pid: this.#pid,
      ...(owner.uid === undefined ? {} : { uid: owner.uid }),
      ...(owner.windowsSid === undefined ? {} : { windowsSid: owner.windowsSid }),
      createdAt: this.#now().toISOString(),
    };
    await writeExclusiveMarker(path.join(instancePath, INSTANCE_MARKER_NAME), marker);
    this.#ownedInstancePaths.add(instancePath);
    return {
      parentPath,
      parentIdentity,
      rootMarker,
      instancePath,
      instanceIdentity,
      instanceMarker: marker,
    };
  }

  async #scavengeStaleInstances(parentPath: string): Promise<void> {
    const owner = await this.#owner();
    const names = await readdir(parentPath);
    for (const name of names) {
      const instanceChild = name.startsWith(INSTANCE_PREFIX);
      const quarantinedChild = name.startsWith(QUARANTINE_PREFIX);
      if (!instanceChild && !quarantinedChild) continue;
      const instancePath = path.join(parentPath, name);
      if (this.#ownedInstancePaths.has(instancePath)) continue;
      const validated = await validatedInstance(
        instancePath,
        parentPath,
        instanceChild ? name.slice(INSTANCE_PREFIX.length) : undefined,
        owner,
      );
      if (validated === null) continue;
      const markerAge = Math.max(0, this.#now().getTime() - Date.parse(validated.marker.createdAt));
      if (this.#isProcessAlive(validated.marker.pid) && markerAge <= this.#liveMarkerMaxAgeMs) {
        continue;
      }
      if (instanceChild) {
        await removeValidatedStaleInstance(
          instancePath,
          parentPath,
          validated,
          validId(this.#createId()),
          owner,
        );
      } else {
        await removeValidatedQuarantinedInstance(instancePath, parentPath, validated, owner);
      }
    }
  }

  async #owner(): Promise<StorageOwner> {
    this.#ownerPromise ??= this.#resolveOwner();
    try {
      return await this.#ownerPromise;
    } catch (error) {
      this.#ownerPromise = undefined;
      throw error;
    }
  }

  async #hostBase(): Promise<string> {
    this.#hostBasePromise ??= this.#resolveHostBase();
    try {
      return await this.#hostBasePromise;
    } catch (error) {
      this.#hostBasePromise = undefined;
      throw error;
    }
  }

  async #resolveHostBase(): Promise<string> {
    if (this.#platform !== 'win32') return await canonicalBase(this.#hostBasePath, true);
    const owner = await this.#owner();
    if (owner.windowsSid === undefined || owner.windowsSecurity === undefined) {
      throw new Error(
        'Windows context snapshot security is unavailable. No agent context was launched.',
      );
    }
    try {
      return await canonicalBase(this.#hostBasePath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    const resolvedBase = path.resolve(this.#hostBasePath);
    const parentPath = await canonicalBase(path.dirname(resolvedBase));
    await owner.windowsSecurity.assertSafeParent(parentPath, owner.windowsSid);
    let created = false;
    try {
      await mkdir(resolvedBase, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    if (created) {
      await protectCreatedPrivateDirectory(resolvedBase, parentPath, owner);
    } else {
      await validatePrivateDirectoryShape(resolvedBase, parentPath, owner);
      await owner.windowsSecurity.assertSafeParent(resolvedBase, owner.windowsSid);
    }
    return await canonicalBase(resolvedBase);
  }

  async #revalidateParentState(parent: ParentState, owner: StorageOwner): Promise<void> {
    const basePath = path.dirname(parent.parentPath);
    if (owner.windowsSid !== undefined && owner.windowsSecurity !== undefined) {
      await owner.windowsSecurity.assertSafeParent(basePath, owner.windowsSid);
    }
    const parentIdentity = await validatePrivateDirectory(parent.parentPath, basePath, owner);
    if (!sameIdentity(parent.parentIdentity, parentIdentity)) {
      throw new Error('The private context snapshot parent changed before snapshot creation.');
    }
    const rootMarker = parseRootMarker(
      await readValidatedMarker(
        path.join(parent.parentPath, ROOT_MARKER_NAME),
        parent.parentPath,
        owner,
      ),
    );
    if (!rootMarkersEqual(rootMarker, parent.rootMarker)) {
      throw new Error(
        'The private context snapshot parent marker changed before snapshot creation.',
      );
    }
    const instanceIdentity = await validatePrivateDirectory(
      parent.instancePath,
      parent.parentPath,
      owner,
    );
    if (!sameIdentity(parent.instanceIdentity, instanceIdentity)) {
      throw new Error('The private context snapshot instance changed before snapshot creation.');
    }
    const instanceMarker = parseInstanceMarker(
      await readValidatedMarker(
        path.join(parent.instancePath, INSTANCE_MARKER_NAME),
        parent.instancePath,
        owner,
      ),
    );
    if (!instanceMarkersEqual(instanceMarker, parent.instanceMarker)) {
      throw new Error(
        'The private context snapshot instance marker changed before snapshot creation.',
      );
    }
  }

  async #resolveOwner(): Promise<StorageOwner> {
    if (this.#platform !== 'win32') {
      return { platform: this.#platform, ...(this.#uid === undefined ? {} : { uid: this.#uid }) };
    }
    if (this.#windowsSecurity === undefined) {
      throw new Error(
        'Windows context snapshot security is unavailable. No agent context was launched.',
      );
    }
    return {
      platform: this.#platform,
      windowsSid: await this.#windowsSecurity.currentUserSid(),
      windowsSecurity: this.#windowsSecurity,
    };
  }
}

let defaultManager = process.platform === 'win32' ? undefined : new ContextSnapshotStorageManager();
let defaultHostBasePath = process.platform === 'win32' ? undefined : tmpdir();

export async function initializeHostContextSnapshotStorage(hostBasePath?: string): Promise<void> {
  if (process.platform === 'win32' && hostBasePath === undefined) {
    throw new Error(
      "Windows context snapshot storage requires Artemis's per-user application-data folder.",
    );
  }
  const selectedBase = hostBasePath ?? tmpdir();
  if (defaultManager !== undefined && defaultHostBasePath !== undefined) {
    if (!pathsEqual(defaultHostBasePath, selectedBase)) {
      throw new Error('Context snapshot storage was already initialized for another host base.');
    }
  } else {
    defaultManager = new ContextSnapshotStorageManager({ hostBasePath: selectedBase });
    defaultHostBasePath = selectedBase;
  }
  await defaultManager.initializeHost();
}

export async function createContextSnapshotDirectory(
  request: ContextSnapshotStorageRequest,
): Promise<ContextSnapshotDirectoryLease> {
  if (defaultManager === undefined) {
    throw new Error(
      'Windows context snapshot storage is not initialized for this user. Reopen Artemis before running an agent with context.',
    );
  }
  return await defaultManager.createSnapshotDirectory(request);
}

async function canonicalBase(candidate: string, allowPlatformTempAlias = false): Promise<string> {
  const resolved = path.resolve(candidate);
  const details = await lstat(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('The private context snapshot base must be an ordinary directory.');
  }
  const canonical = await realpath(resolved);
  if (!allowPlatformTempAlias && !pathsEqual(canonical, resolved)) {
    throw new Error('The private context snapshot base cannot cross a symbolic-link alias.');
  }
  return canonical;
}

async function validatePrivateDirectory(
  candidate: string,
  parent: string,
  owner: StorageOwner,
  requiredOwnerBits = 0o700,
): Promise<Stats> {
  const details = await validatePrivateDirectoryShape(candidate, parent, owner);
  if (
    owner.platform !== 'win32' &&
    ((details.mode & 0o077) !== 0 || (details.mode & requiredOwnerBits) !== requiredOwnerBits)
  ) {
    throw new Error('Private context snapshot storage permissions are not owner-only.');
  }
  if (owner.windowsSid !== undefined && owner.windowsSecurity !== undefined) {
    await owner.windowsSecurity.assertPrivateDirectory(candidate, owner.windowsSid);
  }
  return details;
}

async function protectCreatedPrivateDirectory(
  candidate: string,
  parent: string,
  owner: StorageOwner,
  requiredOwnerBits = 0o700,
): Promise<Stats> {
  const before = await validatePrivateDirectoryShape(candidate, parent, owner);
  if (owner.windowsSid !== undefined && owner.windowsSecurity !== undefined) {
    await owner.windowsSecurity.protectPrivateDirectory(candidate, owner.windowsSid);
    const after = await validatePrivateDirectoryShape(candidate, parent, owner);
    if (!sameIdentity(before, after)) {
      throw new Error(
        'The private Windows context snapshot directory changed while its permissions were applied.',
      );
    }
    return after;
  }
  await chmod(candidate, 0o700);
  return await validatePrivateDirectory(candidate, parent, owner, requiredOwnerBits);
}

async function validatePrivateDirectoryShape(
  candidate: string,
  parent: string,
  owner: StorageOwner,
): Promise<Stats> {
  const details = await lstat(candidate);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('Private context snapshot storage contains a non-directory alias.');
  }
  assertOwned(details, owner.uid);
  const canonical = await realpath(candidate);
  if (!pathsEqual(canonical, path.resolve(candidate)) || !isDirectChild(parent, canonical)) {
    throw new Error('Private context snapshot storage escaped its approved parent.');
  }
  return details;
}

async function validatePrivateSnapshotFile(
  candidate: string,
  rootPath: string,
  owner: StorageOwner,
): Promise<Stats> {
  const details = await validateSnapshotFileShape(candidate, rootPath, owner);
  if (owner.platform !== 'win32' && (details.mode & 0o222) !== 0) {
    throw new Error('A private context snapshot file became writable before launch.');
  }
  if (owner.windowsSid !== undefined && owner.windowsSecurity !== undefined) {
    await owner.windowsSecurity.assertPrivateFile(candidate, owner.windowsSid);
  }
  return details;
}

async function validateSnapshotFileShape(
  candidate: string,
  rootPath: string,
  owner: StorageOwner,
): Promise<Stats> {
  const resolved = path.resolve(candidate);
  const details = await lstat(resolved);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error('Private context snapshot storage contains a non-file alias.');
  }
  assertOwned(details, owner.uid);
  const canonical = await realpath(resolved);
  if (!pathsEqual(canonical, resolved) || !isDirectChild(rootPath, canonical)) {
    throw new Error('A private context snapshot file escaped its approved directory.');
  }
  return details;
}

async function readValidatedMarker(
  markerPath: string,
  parent: string,
  owner: StorageOwner,
): Promise<unknown> {
  const before = await lstat(markerPath);
  validateMarkerDetails(before, owner);
  if (!isDirectChild(parent, markerPath)) {
    throw new Error('Private context snapshot ownership marker escaped its parent.');
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(markerPath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const afterOpen = await lstat(markerPath);
    validateMarkerDetails(opened, owner);
    validateMarkerDetails(afterOpen, owner);
    if (!sameStableIdentity(before, opened) || !sameStableIdentity(opened, afterOpen)) {
      throw new Error('Private context snapshot ownership marker changed while opening.');
    }
    const contents = await readBoundedMarker(handle);
    const finalDetails = await handle.stat();
    if (!sameStableIdentity(opened, finalDetails)) {
      throw new Error('Private context snapshot ownership marker changed while reading.');
    }
    return JSON.parse(contents) as unknown;
  } finally {
    await handle.close();
  }
}

async function readBoundedMarker(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const buffer = Buffer.allocUnsafe(MARKER_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset < 2 || offset > MARKER_MAX_BYTES) {
    throw new Error('Private context snapshot storage has an invalid ownership marker.');
  }
  return buffer.subarray(0, offset).toString('utf8');
}

function validateMarkerDetails(details: Stats, owner: StorageOwner): void {
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.nlink !== 1 ||
    details.size < 2 ||
    details.size > MARKER_MAX_BYTES
  ) {
    throw new Error('Private context snapshot storage has an invalid ownership marker.');
  }
  assertOwned(details, owner.uid);
  if (
    owner.platform !== 'win32' &&
    ((details.mode & 0o077) !== 0 || (details.mode & 0o222) !== 0)
  ) {
    throw new Error('Private context snapshot ownership marker permissions are unsafe.');
  }
}

async function writeExclusiveMarker(markerPath: string, marker: RootMarker | InstanceMarker) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    markerPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o400,
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validatedInstance(
  instancePath: string,
  parentPath: string,
  expectedId: string | undefined,
  owner: StorageOwner,
): Promise<{ readonly identity: Stats; readonly marker: InstanceMarker } | null> {
  try {
    if (expectedId !== undefined) validId(expectedId);
    const identity = await validatePrivateDirectory(instancePath, parentPath, owner);
    const marker = parseInstanceMarker(
      await readValidatedMarker(path.join(instancePath, INSTANCE_MARKER_NAME), instancePath, owner),
    );
    if (
      (expectedId !== undefined && marker.instanceId !== expectedId) ||
      !pathsEqual(marker.parentPath, parentPath) ||
      marker.uid !== owner.uid ||
      marker.windowsSid !== owner.windowsSid
    ) {
      return null;
    }
    return { identity, marker };
  } catch {
    return null;
  }
}

async function removeValidatedStaleInstance(
  instancePath: string,
  parentPath: string,
  validated: { readonly identity: Stats; readonly marker: InstanceMarker },
  quarantineId: string,
  owner: StorageOwner,
): Promise<void> {
  const quarantinePath = path.join(parentPath, `${QUARANTINE_PREFIX}${quarantineId}`);
  try {
    await rename(instancePath, quarantinePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  const moved = await lstat(quarantinePath);
  if (!sameIdentity(validated.identity, moved)) {
    throw new Error('A stale private context snapshot changed during quarantine.');
  }
  await removeValidatedQuarantinedInstance(quarantinePath, parentPath, validated, owner);
}

async function removeValidatedQuarantinedInstance(
  quarantinePath: string,
  parentPath: string,
  validated: { readonly identity: Stats; readonly marker: InstanceMarker },
  owner: StorageOwner,
): Promise<void> {
  const current = await lstat(quarantinePath);
  if (!sameIdentity(validated.identity, current)) {
    throw new Error('A stale private context snapshot changed before deletion.');
  }
  await validatePrivateDirectory(quarantinePath, parentPath, owner);
  const marker = parseInstanceMarker(
    await readValidatedMarker(
      path.join(quarantinePath, INSTANCE_MARKER_NAME),
      quarantinePath,
      owner,
    ),
  );
  if (
    !instanceMarkersEqual(marker, validated.marker) ||
    !pathsEqual(marker.parentPath, parentPath)
  ) {
    throw new Error('A stale private context snapshot marker changed during quarantine.');
  }
  await prepareTreeForRemoval(quarantinePath, owner);
  await rm(quarantinePath, { recursive: true, force: false });
}

async function prepareTreeForRemoval(directory: string, owner: StorageOwner): Promise<void> {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) return;
  assertOwned(details, owner.uid);
  if (owner.platform !== 'win32') await chmod(directory, 0o700);
  for (const name of await readdir(directory)) {
    const child = path.join(directory, name);
    const childDetails = await lstat(child);
    assertOwned(childDetails, owner.uid);
    if (childDetails.isDirectory() && !childDetails.isSymbolicLink()) {
      await prepareTreeForRemoval(child, owner);
    }
  }
}

function parseRootMarker(value: unknown): RootMarker {
  if (
    !isRecord(value) ||
    value.format !== MARKER_FORMAT ||
    value.version !== MARKER_VERSION ||
    value.kind !== 'root' ||
    (value.scope !== 'host' && value.scope !== 'managed') ||
    typeof value.basePath !== 'string' ||
    (value.windowsSid !== undefined && !isWindowsSid(value.windowsSid)) ||
    !hasExactKeys(value, [
      'basePath',
      'format',
      'kind',
      'scope',
      'version',
      ...(value.windowsSid === undefined ? [] : ['windowsSid']),
    ])
  ) {
    throw new Error('The private context snapshot parent marker is invalid.');
  }
  return value as unknown as RootMarker;
}

function parseInstanceMarker(value: unknown): InstanceMarker {
  if (
    !isRecord(value) ||
    value.format !== MARKER_FORMAT ||
    value.version !== MARKER_VERSION ||
    value.kind !== 'instance' ||
    typeof value.instanceId !== 'string' ||
    typeof value.parentPath !== 'string' ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    (value.uid !== undefined && (!Number.isSafeInteger(value.uid) || Number(value.uid) < 0)) ||
    (value.windowsSid !== undefined && !isWindowsSid(value.windowsSid)) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !hasExactKeys(value, [
      'createdAt',
      'format',
      'instanceId',
      'kind',
      'parentPath',
      'pid',
      ...(value.uid === undefined ? [] : ['uid']),
      'version',
      ...(value.windowsSid === undefined ? [] : ['windowsSid']),
    ])
  ) {
    throw new Error('The private context snapshot instance marker is invalid.');
  }
  validId(value.instanceId);
  return value as unknown as InstanceMarker;
}

function rootMarkersEqual(left: RootMarker, right: RootMarker): boolean {
  return (
    left.format === right.format &&
    left.version === right.version &&
    left.kind === right.kind &&
    left.scope === right.scope &&
    pathsEqual(left.basePath, right.basePath) &&
    left.windowsSid === right.windowsSid
  );
}

function instanceMarkersEqual(left: InstanceMarker, right: InstanceMarker): boolean {
  return (
    left.format === right.format &&
    left.version === right.version &&
    left.kind === right.kind &&
    left.instanceId === right.instanceId &&
    pathsEqual(left.parentPath, right.parentPath) &&
    left.pid === right.pid &&
    left.uid === right.uid &&
    left.windowsSid === right.windowsSid &&
    left.createdAt === right.createdAt
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => key === actual[index])
  );
}

function validId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('Private context snapshot storage generated an invalid identity.');
  }
  return value.toLowerCase();
}

function privateParentName(scope: SnapshotStoreScope, owner: StorageOwner): string {
  if (owner.windowsSid !== undefined) {
    const sidDigest = createHash('sha256')
      .update('forgeboard-windows-snapshot-owner\0', 'utf8')
      .update(owner.windowsSid, 'utf8')
      .digest('hex');
    return `${STORE_DIRECTORY_NAME}-${scope}-sid-${sidDigest}`;
  }
  return scope === 'host' && owner.uid !== undefined
    ? `${STORE_DIRECTORY_NAME}-uid-${String(owner.uid)}`
    : STORE_DIRECTORY_NAME;
}

function isWindowsSid(value: unknown): value is string {
  return typeof value === 'string' && /^S-\d(?:-\d+){1,15}$/u.test(value) && value.length <= 184;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function assertOwned(details: Stats, uid: number | undefined): void {
  if (uid !== undefined && details.uid !== uid) {
    throw new Error('Private context snapshot storage is not owned by the current user.');
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableIdentity(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isDirectChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.includes(path.sep) && !path.isAbsolute(relative);
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}
