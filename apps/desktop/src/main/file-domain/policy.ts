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
 * Sensitivity gates what leaves the local user's hands, not what they can see:
 * the tree, read, save, and reveal paths all serve sensitive entries to the
 * local user, who owns the files anyway. This assertion remains on the
 * agent-facing surfaces — attachment manifests, conflict shipping, and media
 * import — where credential-like content must never travel automatically.
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
