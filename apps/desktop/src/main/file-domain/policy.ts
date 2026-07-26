import { findSensitivePath, type IgnoreMatcher } from '@forgeboard/core';

import type { FileEntryPolicy } from '../../shared/files/contracts.js';
import { FileDomainError } from './errors.js';

export function evaluateFilePolicy(
  matcher: IgnoreMatcher,
  relativePath: string,
  isDirectory: boolean,
  isSymbolicLink = false,
): FileEntryPolicy {
  if (isSymbolicLink) {
    return {
      status: 'symlink',
      reason: 'Symbolic links are not opened in the embedded editor.',
    };
  }

  const sensitive = findSensitivePath(relativePath);
  if (sensitive !== undefined) return { status: 'sensitive', reason: sensitive.reason };

  const ignore = matcher.evaluate(relativePath, isDirectory);
  if (ignore.ignored) {
    return {
      status: 'ignored',
      reason: `Ignored by ${ignore.rule?.source ?? 'project policy'}.`,
    };
  }
  return { status: 'normal', reason: null };
}

/**
 * Sensitivity is the only content boundary: credential-like paths never reach the
 * renderer. Being git-ignored is a scope signal rather than a secret, so an ignored
 * file opens and renders its real content like any other file.
 *
 * Project-wide *search* still skips ignored files (see searchProjectFiles) because
 * walking node_modules, .venv, and build output would cost far more than it returns —
 * that is a performance scope decision, not a refusal, and it must never stop a
 * directly requested read, image, or video from succeeding.
 */
export function assertFileContentNotSensitive(relativePath: string): void {
  if (findSensitivePath(relativePath) !== undefined) {
    throw new FileDomainError(
      'SENSITIVE_FILE',
      'Sensitive files are not exposed to the embedded renderer.',
    );
  }
}

/**
 * Tree listings show ignored entries (the UI marks them), so only sensitive
 * paths are refused here.
 */
export function assertDirectoryListable(relativePath: string): void {
  const sensitive = findSensitivePath(relativePath);
  if (sensitive !== undefined) {
    throw new FileDomainError('SENSITIVE_FILE', sensitive.reason);
  }
}
