import {
  currentWindowsUserSid,
  inspectWindowsFilesystemAcl,
  protectWindowsFilesystemAcl,
} from '@forgeboard/windows-durable-fs';

const ACL_SCHEMA_VERSION = 2;
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const CREATOR_OWNER_SID = 'S-1-3-0';
const OWNER_RIGHTS_SID = 'S-1-3-4';
const INHERITS_TO_CHILDREN = 0x3;
const INHERIT_ONLY = 0x2;
const FILE_SYSTEM_FULL_CONTROL = 0x1f01ff;
const DANGEROUS_PARENT_RIGHTS =
  0x10000000 | // Generic all, if an unusual raw ACE survives .NET normalization.
  0x40000000 | // Generic write, if an unusual raw ACE survives .NET normalization.
  0x2 | // Create files / write data.
  0x4 | // Create directories / append data.
  0x10 | // Write extended attributes.
  0x40 | // Delete child directories and files.
  0x100 | // Write attributes.
  0x10000 | // Delete this directory.
  0x40000 | // Change permissions.
  0x80000; // Take ownership.

export type WindowsAclBoundaryErrorCode =
  | 'identity-unavailable'
  | 'inspection-unavailable'
  | 'unsafe-parent'
  | 'protection-failed'
  | 'unsafe-private-directory'
  | 'unsafe-private-file';

export class WindowsAclBoundaryError extends Error {
  public constructor(
    readonly code: WindowsAclBoundaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WindowsAclBoundaryError';
  }
}

export interface WindowsAclRule {
  readonly sid: string;
  readonly accessType: 'Allow' | 'Deny';
  readonly rights: number;
  readonly inherited: boolean;
  readonly inheritanceFlags: number;
  readonly propagationFlags: number;
}

export interface WindowsDirectoryAcl {
  readonly schemaVersion: typeof ACL_SCHEMA_VERSION;
  readonly ownerSid: string;
  readonly daclPresent: boolean;
  readonly hasUnsupportedDaclAce: boolean;
  readonly protected: boolean;
  readonly rules: readonly WindowsAclRule[];
}

export interface WindowsFilesystemSecurity {
  currentUserSid(): Promise<string>;
  assertSafeParent(directoryPath: string, currentUserSid: string): Promise<void>;
  assertConfidentialParent(directoryPath: string, currentUserSid: string): Promise<void>;
  protectPrivateDirectory(directoryPath: string, currentUserSid: string): Promise<void>;
  assertPrivateDirectory(directoryPath: string, currentUserSid: string): Promise<void>;
  protectPrivateFile(filePath: string, currentUserSid: string): Promise<void>;
  assertPrivateFile(filePath: string, currentUserSid: string): Promise<void>;
}

type InspectWindowsAcl = (path: string) => Promise<string>;
type ProtectWindowsAcl = (
  path: string,
  currentUserSid: string,
  directory: boolean,
) => Promise<void>;
type ResolveWindowsUserSid = () => Promise<string>;

export class NativeWindowsFilesystemSecurity implements WindowsFilesystemSecurity {
  readonly #inspectWindowsAcl: InspectWindowsAcl;
  readonly #protectWindowsAcl: ProtectWindowsAcl;
  readonly #resolveWindowsUserSid: ResolveWindowsUserSid;
  #currentSid: Promise<string> | undefined;

  public constructor(
    inspectWindowsAcl: InspectWindowsAcl = inspectWindowsFilesystemAcl,
    protectWindowsAcl: ProtectWindowsAcl = protectWindowsFilesystemAcl,
    resolveWindowsUserSid: ResolveWindowsUserSid = currentWindowsUserSid,
  ) {
    this.#inspectWindowsAcl = inspectWindowsAcl;
    this.#protectWindowsAcl = protectWindowsAcl;
    this.#resolveWindowsUserSid = resolveWindowsUserSid;
  }

  public async currentUserSid(): Promise<string> {
    this.#currentSid ??= this.#resolveCurrentUserSid();
    try {
      return await this.#currentSid;
    } catch (error) {
      this.#currentSid = undefined;
      throw error;
    }
  }

  public async assertSafeParent(directoryPath: string, currentUserSid: string): Promise<void> {
    let report: WindowsDirectoryAcl;
    try {
      report = await this.#inspectDirectory(directoryPath);
    } catch (error) {
      if (error instanceof WindowsAclBoundaryError) throw error;
      throw new WindowsAclBoundaryError(
        'inspection-unavailable',
        'Forgeboard could not verify Windows folder permissions. Choose a private folder inside your Windows profile or repair Windows access-control services.',
      );
    }
    assertSafeWindowsParentAcl(report, currentUserSid);
  }

  public async assertConfidentialParent(
    directoryPath: string,
    currentUserSid: string,
  ): Promise<void> {
    let report: WindowsDirectoryAcl;
    try {
      report = await this.#inspectDirectory(directoryPath);
    } catch (error) {
      if (error instanceof WindowsAclBoundaryError) throw error;
      throw inspectionUnavailable();
    }
    assertConfidentialWindowsParentAcl(report, currentUserSid);
  }

  public async protectPrivateDirectory(
    directoryPath: string,
    currentUserSid: string,
  ): Promise<void> {
    assertWindowsSid(currentUserSid);
    try {
      await this.#protectWindowsAcl(directoryPath, currentUserSid, true);
    } catch {
      throw new WindowsAclBoundaryError(
        'protection-failed',
        'Forgeboard could not make its Windows data folder private. No private data was used; repair the folder permissions and try again.',
      );
    }
    await this.assertPrivateDirectory(directoryPath, currentUserSid);
  }

  public async assertPrivateDirectory(
    directoryPath: string,
    currentUserSid: string,
  ): Promise<void> {
    let report: WindowsDirectoryAcl;
    try {
      report = await this.#inspectDirectory(directoryPath);
    } catch (error) {
      if (error instanceof WindowsAclBoundaryError) throw error;
      throw new WindowsAclBoundaryError(
        'inspection-unavailable',
        'Forgeboard could not recheck its private Windows data-folder permissions. No private data was used.',
      );
    }
    assertPrivateWindowsDirectoryAcl(report, currentUserSid);
  }

  public async protectPrivateFile(filePath: string, currentUserSid: string): Promise<void> {
    assertWindowsSid(currentUserSid);
    try {
      await this.#protectWindowsAcl(filePath, currentUserSid, false);
    } catch {
      throw new WindowsAclBoundaryError(
        'protection-failed',
        'Forgeboard could not make its Windows data file private. The operation stopped before publication; repair the folder permissions and try again.',
      );
    }
    await this.assertPrivateFile(filePath, currentUserSid);
  }

  public async assertPrivateFile(filePath: string, currentUserSid: string): Promise<void> {
    let report: WindowsDirectoryAcl;
    try {
      report = await this.#inspectFile(filePath);
    } catch (error) {
      if (error instanceof WindowsAclBoundaryError) throw error;
      throw new WindowsAclBoundaryError(
        'inspection-unavailable',
        'Forgeboard could not recheck its private Windows data-file permissions. The operation stopped before publication.',
      );
    }
    assertPrivateWindowsFileAcl(report, currentUserSid);
  }

  async #resolveCurrentUserSid(): Promise<string> {
    try {
      return assertWindowsSid(await this.#resolveWindowsUserSid());
    } catch {
      throw new WindowsAclBoundaryError(
        'identity-unavailable',
        'Forgeboard could not verify the current Windows account SID. Reopen Forgeboard or repair Windows identity services before running an agent with context.',
      );
    }
  }

  async #inspectDirectory(directoryPath: string): Promise<WindowsDirectoryAcl> {
    return parseWindowsDirectoryAcl(await this.#inspectWindowsAcl(directoryPath));
  }

  async #inspectFile(filePath: string): Promise<WindowsDirectoryAcl> {
    return parseWindowsDirectoryAcl(await this.#inspectWindowsAcl(filePath));
  }
}

export const windowsFilesystemSecurity = new NativeWindowsFilesystemSecurity();

export function assertSafeWindowsParentAcl(
  report: WindowsDirectoryAcl,
  currentUserSid: string,
): void {
  const userSid = assertWindowsSid(currentUserSid);
  const trustedOwners = new Set([userSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  if (!report.daclPresent || report.hasUnsupportedDaclAce || !trustedOwners.has(report.ownerSid)) {
    throw new WindowsAclBoundaryError(
      'unsafe-parent',
      'The selected Windows folder is controlled by another local account. Choose a private folder inside your Windows profile.',
    );
  }
  for (const rule of report.rules) {
    if (rule.accessType !== 'Allow' || (rule.rights & DANGEROUS_PARENT_RIGHTS) === 0) continue;
    if (!ruleAppliesToDirectoryOrChildren(rule)) continue;
    if (trustedParentRule(rule, userSid)) continue;
    throw new WindowsAclBoundaryError(
      'unsafe-parent',
      'The selected Windows folder lets another local account create, replace, or delete its contents. Choose a private folder inside your Windows profile or remove shared write access.',
    );
  }
}

/**
 * A stricter parent check for already-existing confidential destinations. Unlike the structural
 * parent check, this also rejects another principal's ability to discover or traverse contents.
 */
export function assertConfidentialWindowsParentAcl(
  report: WindowsDirectoryAcl,
  currentUserSid: string,
): void {
  assertSafeWindowsParentAcl(report, currentUserSid);
  const userSid = assertWindowsSid(currentUserSid);
  for (const rule of report.rules) {
    if (rule.accessType !== 'Allow' || !ruleAppliesToDirectoryOrChildren(rule)) continue;
    if (trustedParentRule(rule, userSid)) continue;
    if (!grantsConfidentialDataAccess(rule.rights)) continue;
    throw new WindowsAclBoundaryError(
      'unsafe-parent',
      'The selected Windows folder lets another local account read or discover its contents. Choose a private folder inside your Windows profile or remove shared access.',
    );
  }
}

export function assertPrivateWindowsDirectoryAcl(
  report: WindowsDirectoryAcl,
  currentUserSid: string,
): void {
  const userSid = assertWindowsSid(currentUserSid);
  const expectedSids = new Set([userSid, SYSTEM_SID]);
  const observedSids = new Set<string>();
  if (
    report.ownerSid !== userSid ||
    !report.daclPresent ||
    report.hasUnsupportedDaclAce ||
    !report.protected ||
    report.rules.length !== expectedSids.size
  ) {
    throw unsafePrivateDirectory();
  }
  for (const rule of report.rules) {
    if (
      rule.accessType !== 'Allow' ||
      rule.inherited ||
      rule.rights !== FILE_SYSTEM_FULL_CONTROL ||
      (rule.inheritanceFlags & 0x3) !== 0x3 ||
      rule.propagationFlags !== 0 ||
      !expectedSids.has(rule.sid) ||
      observedSids.has(rule.sid)
    ) {
      throw unsafePrivateDirectory();
    }
    observedSids.add(rule.sid);
  }
  if ([...expectedSids].some((sid) => !observedSids.has(sid))) {
    throw unsafePrivateDirectory();
  }
}

export function assertPrivateWindowsFileAcl(
  report: WindowsDirectoryAcl,
  currentUserSid: string,
): void {
  const userSid = assertWindowsSid(currentUserSid);
  const expectedSids = new Set([userSid, SYSTEM_SID]);
  const observedSids = new Set<string>();
  if (
    report.ownerSid !== userSid ||
    !report.daclPresent ||
    report.hasUnsupportedDaclAce ||
    !report.protected ||
    report.rules.length !== expectedSids.size
  ) {
    throw unsafePrivateFile();
  }
  for (const rule of report.rules) {
    if (
      rule.accessType !== 'Allow' ||
      rule.inherited ||
      rule.rights !== FILE_SYSTEM_FULL_CONTROL ||
      rule.inheritanceFlags !== 0 ||
      rule.propagationFlags !== 0 ||
      !expectedSids.has(rule.sid) ||
      observedSids.has(rule.sid)
    ) {
      throw unsafePrivateFile();
    }
    observedSids.add(rule.sid);
  }
  if ([...expectedSids].some((sid) => !observedSids.has(sid))) {
    throw unsafePrivateFile();
  }
}

export function parseWindowsDirectoryAcl(serialized: string): WindowsDirectoryAcl {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new WindowsAclBoundaryError(
      'inspection-unavailable',
      'Forgeboard received an invalid Windows folder-permission report. No agent context was launched.',
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'daclPresent',
      'hasUnsupportedDaclAce',
      'ownerSid',
      'protected',
      'rules',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== ACL_SCHEMA_VERSION ||
    typeof value.ownerSid !== 'string' ||
    typeof value.daclPresent !== 'boolean' ||
    typeof value.hasUnsupportedDaclAce !== 'boolean' ||
    typeof value.protected !== 'boolean' ||
    !Array.isArray(value.rules) ||
    value.rules.length > 256
  ) {
    throw invalidAclReport();
  }
  const ownerSid = assertWindowsSid(value.ownerSid);
  const rules = value.rules.map((candidate) => parseAclRule(candidate));
  return {
    schemaVersion: ACL_SCHEMA_VERSION,
    ownerSid,
    daclPresent: value.daclPresent,
    hasUnsupportedDaclAce: value.hasUnsupportedDaclAce,
    protected: value.protected,
    rules,
  };
}

function parseAclRule(value: unknown): WindowsAclRule {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'accessType',
      'inheritanceFlags',
      'inherited',
      'propagationFlags',
      'rights',
      'sid',
    ]) ||
    typeof value.sid !== 'string' ||
    (value.accessType !== 'Allow' && value.accessType !== 'Deny') ||
    !isUint32(value.rights) ||
    typeof value.inherited !== 'boolean' ||
    !isBoundedFlags(value.inheritanceFlags, 0x3) ||
    !isBoundedFlags(value.propagationFlags, 0x3)
  ) {
    throw invalidAclReport();
  }
  return {
    sid: assertWindowsSid(value.sid),
    accessType: value.accessType,
    rights: value.rights,
    inherited: value.inherited,
    inheritanceFlags: value.inheritanceFlags,
    propagationFlags: value.propagationFlags,
  };
}

function trustedParentRule(rule: WindowsAclRule, currentUserSid: string): boolean {
  if ([currentUserSid, SYSTEM_SID, ADMINISTRATORS_SID].includes(rule.sid)) return true;
  if (rule.sid === OWNER_RIGHTS_SID) return true;
  return rule.sid === CREATOR_OWNER_SID && (rule.propagationFlags & INHERIT_ONLY) !== 0;
}

function ruleAppliesToDirectoryOrChildren(rule: WindowsAclRule): boolean {
  return (
    (rule.propagationFlags & INHERIT_ONLY) === 0 ||
    (rule.inheritanceFlags & INHERITS_TO_CHILDREN) !== 0
  );
}

function grantsConfidentialDataAccess(rights: number): boolean {
  const masks = [
    0x1, // List directory / read data.
    0x8, // Read extended attributes.
    0x20, // Traverse directory / execute file.
    0x80, // Read attributes.
    0x20000000, // Generic execute.
    0x80000000, // Generic read.
  ];
  return masks.some((mask) => (rights & mask) !== 0);
}

function assertWindowsSid(value: string): string {
  const normalized = value.toUpperCase();
  if (!/^S-\d(?:-\d+){1,15}$/u.test(normalized) || normalized.length > 184) {
    throw new WindowsAclBoundaryError(
      'identity-unavailable',
      'Forgeboard received an invalid Windows account identity. No agent context was launched.',
    );
  }
  return normalized;
}

function unsafePrivateDirectory(): WindowsAclBoundaryError {
  return new WindowsAclBoundaryError(
    'unsafe-private-directory',
    'Forgeboard Windows data-folder permissions are no longer private to this account. The operation stopped before using private data.',
  );
}

function unsafePrivateFile(): WindowsAclBoundaryError {
  return new WindowsAclBoundaryError(
    'unsafe-private-file',
    'Forgeboard Windows data-file permissions are no longer private to this account. The operation stopped before publication.',
  );
}

function inspectionUnavailable(): WindowsAclBoundaryError {
  return new WindowsAclBoundaryError(
    'inspection-unavailable',
    'Forgeboard could not verify Windows folder permissions. Choose a private folder inside your Windows profile or repair Windows access-control services.',
  );
}

function invalidAclReport(): WindowsAclBoundaryError {
  return new WindowsAclBoundaryError(
    'inspection-unavailable',
    'Forgeboard received an invalid Windows folder-permission report. No agent context was launched.',
  );
}

function isUint32(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}

function isBoundedFlags(value: unknown, mask: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && (Number(value) & ~mask) === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => key === actual[index])
  );
}
