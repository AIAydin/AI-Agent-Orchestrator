import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  FolderReadinessRequestSchema,
  FolderReadinessResultSchema,
  type FolderReadinessRequest,
  type FolderReadinessResult,
} from '../../../shared/settings/folder-readiness.js';
import {
  windowsFilesystemSecurity,
  type WindowsFilesystemSecurity,
} from '../../security/windows/filesystem-acl.js';

interface FolderDetails {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number;
  readonly uid: number;
}

interface FolderReadinessDependencies {
  readonly inspect?: (path: string) => Promise<FolderDetails>;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly verifyWritable?: (path: string) => Promise<void>;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly currentUid?: number | undefined;
  readonly windowsSecurity?: WindowsFilesystemSecurity;
}

/** Passively inspects a destination and its nearest existing parent without creating anything. */
export class FolderReadinessService {
  readonly #inspect: (path: string) => Promise<FolderDetails>;
  readonly #canonicalize: (path: string) => Promise<string>;
  readonly #verifyWritable: (path: string) => Promise<void>;
  readonly #now: () => Date;
  readonly #platform: NodeJS.Platform;
  readonly #currentUid: number | undefined;
  readonly #windowsSecurity: WindowsFilesystemSecurity;

  public constructor(dependencies: FolderReadinessDependencies = {}) {
    this.#inspect = dependencies.inspect ?? lstat;
    this.#canonicalize = dependencies.canonicalize ?? realpath;
    this.#verifyWritable =
      dependencies.verifyWritable ??
      (async (path) => await access(path, constants.W_OK | constants.X_OK));
    this.#now = dependencies.now ?? (() => new Date());
    this.#platform = dependencies.platform ?? process.platform;
    this.#currentUid =
      dependencies.currentUid ??
      (typeof process.getuid === 'function' ? process.getuid() : undefined);
    this.#windowsSecurity = dependencies.windowsSecurity ?? windowsFilesystemSecurity;
  }

  public async check(input: unknown): Promise<FolderReadinessResult> {
    const request = FolderReadinessRequestSchema.parse(input);
    if (!this.#pathApi().isAbsolute(request.path)) {
      return this.#result(request, 'path-not-absolute', {
        reason: 'Choose an absolute folder with Browse before saving.',
      });
    }

    const target = await this.#inspectIfPresent(request.path);
    if (target.outcome === 'error') {
      return this.#result(request, 'unavailable', {
        reason: errorMessage(target.error, 'Artemis could not inspect the selected folder.'),
      });
    }
    if (target.outcome === 'present') {
      return await this.#checkExistingCandidate(
        request,
        request.path,
        target.details,
        'ready-existing',
      );
    }

    let parent = this.#pathApi().dirname(request.path);
    while (true) {
      const candidate = await this.#inspectIfPresent(parent);
      if (candidate.outcome === 'error') {
        return this.#result(request, 'unavailable', {
          reason: errorMessage(
            candidate.error,
            'Artemis could not inspect the selected folder parent.',
          ),
        });
      }
      if (candidate.outcome === 'present') {
        return await this.#checkExistingCandidate(
          request,
          parent,
          candidate.details,
          'ready-parent',
        );
      }
      const next = this.#pathApi().dirname(parent);
      if (next === parent) {
        return this.#result(request, 'unavailable', {
          reason: 'Artemis could not find an existing parent for the selected folder.',
        });
      }
      parent = next;
    }
  }

  async #checkExistingCandidate(
    request: FolderReadinessRequest,
    selectedPath: string,
    selectedDetails: FolderDetails,
    readyState: 'ready-existing' | 'ready-parent',
  ): Promise<FolderReadinessResult> {
    let canonicalPath: string;
    try {
      canonicalPath = await this.#canonicalize(selectedPath);
    } catch (error) {
      return this.#result(request, 'unavailable', {
        reason: errorMessage(error, 'Artemis could not resolve the selected folder safely.'),
      });
    }
    const usesAlias =
      selectedDetails.isSymbolicLink() || !this.#pathsEqual(selectedPath, canonicalPath);
    if (request.purpose === 'managed-worktrees' && usesAlias) {
      return this.#result(request, 'unavailable', {
        reason:
          readyState === 'ready-existing'
            ? 'The managed-worktree folder is an alias or shortcut, not an ordinary folder. Choose an ordinary folder with Browse.'
            : 'A parent of the managed-worktree folder is an alias or shortcut. Choose another folder with Browse.',
      });
    }
    let canonicalDetails = selectedDetails;
    if (usesAlias) {
      const inspected = await this.#inspectIfPresent(canonicalPath);
      if (inspected.outcome === 'error') {
        return this.#result(request, 'unavailable', {
          reason: errorMessage(
            inspected.error,
            'Artemis could not inspect the folder it points to.',
          ),
        });
      }
      if (inspected.outcome === 'missing') {
        return this.#result(request, 'unavailable', {
          reason: 'The folder it points to no longer exists. Choose it again with Browse.',
        });
      }
      canonicalDetails = inspected.details;
    }
    if (!canonicalDetails.isDirectory() || canonicalDetails.isSymbolicLink()) {
      return this.#result(request, 'not-directory', {
        reason:
          readyState === 'ready-existing'
            ? 'The selected path exists but is not an ordinary folder. Choose a folder with Browse.'
            : 'A parent of the selected path is not an ordinary folder. Choose another destination with Browse.',
      });
    }
    const permissionIssue = await this.#permissionIssue(
      request.purpose,
      canonicalPath,
      canonicalDetails,
      readyState === 'ready-existing',
    );
    if (permissionIssue !== null) {
      return this.#result(request, 'unsafe-permissions', { reason: permissionIssue });
    }
    return await this.#checkWritable(
      request,
      canonicalPath,
      readyState,
      usesAlias
        ? 'The selected backup folder is an alias. Artemis will use and verify its canonical destination.'
        : null,
    );
  }

  async #permissionIssue(
    purpose: FolderReadinessRequest['purpose'],
    checkedPath: string,
    details: FolderDetails,
    selectedDestinationExists: boolean,
  ): Promise<string | null> {
    if (this.#platform === 'win32') {
      try {
        const sid = await this.#windowsSecurity.currentUserSid();
        if (purpose === 'backup-destination' && selectedDestinationExists) {
          await this.#windowsSecurity.assertConfidentialParent(checkedPath, sid);
        } else {
          await this.#windowsSecurity.assertSafeParent(checkedPath, sid);
        }
        return null;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Artemis could not verify Windows folder permissions. Choose a private folder inside your Windows profile.';
      }
    }
    if (purpose !== 'backup-destination') return null;
    if ((details.mode & 0o022) !== 0) {
      return 'The backup folder can be changed by another local user. Choose a private folder or remove write access for other users.';
    }
    if (this.#currentUid !== undefined && details.uid !== this.#currentUid) {
      return 'The backup folder is not owned by the current user. Choose a private folder you own.';
    }
    return null;
  }

  async #checkWritable(
    request: FolderReadinessRequest,
    checkedPath: string,
    readyState: 'ready-existing' | 'ready-parent',
    aliasWarning: string | null = null,
  ): Promise<FolderReadinessResult> {
    try {
      await this.#verifyWritable(checkedPath);
      return this.#result(request, readyState, {
        ready: true,
        warning:
          readyState === 'ready-parent'
            ? [
                'The selected folder does not exist yet. Artemis will create it only when the feature first needs it.',
                aliasWarning,
              ]
                .filter((value) => value !== null)
                .join(' ')
            : aliasWarning,
      });
    } catch (error) {
      return this.#result(request, 'not-writable', {
        reason: `${errorMessage(error, 'The selected folder is not writable.')} Choose a writable folder with Browse.`,
      });
    }
  }

  async #inspectIfPresent(
    path: string,
  ): Promise<
    | { readonly outcome: 'present'; readonly details: FolderDetails }
    | { readonly outcome: 'missing' }
    | { readonly outcome: 'error'; readonly error: unknown }
  > {
    try {
      return { outcome: 'present', details: await this.#inspect(path) };
    } catch (error) {
      return hasCode(error, 'ENOENT') ? { outcome: 'missing' } : { outcome: 'error', error };
    }
  }

  #result(
    request: FolderReadinessRequest,
    state: FolderReadinessResult['state'],
    details: {
      readonly ready?: boolean;
      readonly reason?: string | null;
      readonly warning?: string | null;
    },
  ): FolderReadinessResult {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error('Folder readiness time must be valid.');
    return FolderReadinessResultSchema.parse({
      schemaVersion: 1,
      request,
      state,
      ready: details.ready ?? false,
      checkedAt: now.toISOString(),
      reason: details.reason ?? null,
      warning: details.warning ?? null,
    });
  }

  #pathApi(): typeof path.posix {
    return this.#platform === 'win32' ? path.win32 : path.posix;
  }

  #pathsEqual(left: string, right: string): boolean {
    const leftResolved = this.#pathApi().resolve(left);
    const rightResolved = this.#pathApi().resolve(right);
    return this.#platform === 'win32'
      ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
      : leftResolved === rightResolved;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM')) {
    return 'Artemis does not have permission to access the selected folder.';
  }
  if (hasCode(error, 'ELOOP')) {
    return 'The selected folder path points to itself through an alias or shortcut.';
  }
  if (hasCode(error, 'ENAMETOOLONG')) {
    return 'The selected folder path is too long for this system.';
  }
  return fallback;
}
