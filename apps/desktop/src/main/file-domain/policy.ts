import { findSensitivePath, type IgnoreMatcher, type SensitivePathFinding } from '@forgeboard/core';

import type { FileEntryPolicy } from '../../shared/files/contracts.js';
import { FileDomainError } from './errors.js';

interface EvaluatedFilePolicy {
  readonly entry: FileEntryPolicy;
  readonly sensitive?: SensitivePathFinding;
  readonly ignored: boolean;
}

export function evaluateFilePolicy(
  matcher: IgnoreMatcher,
  relativePath: string,
  isDirectory: boolean,
  isSymbolicLink = false,
): EvaluatedFilePolicy {
  if (isSymbolicLink) {
    return {
      entry: {
        status: 'symlink',
        reason: 'Symbolic links are not opened in the embedded editor.',
      },
      ignored: false,
    };
  }

  const sensitive = findSensitivePath(relativePath);
  if (sensitive !== undefined) {
    return {
      entry: { status: 'sensitive', reason: sensitive.reason },
      sensitive,
      ignored: false,
    };
  }

  const ignore = matcher.evaluate(relativePath, isDirectory);
  if (ignore.ignored) {
    return {
      entry: {
        status: 'ignored',
        reason: `Ignored by ${ignore.rule?.source ?? 'project policy'}.`,
      },
      ignored: true,
    };
  }
  return { entry: { status: 'normal', reason: null }, ignored: false };
}

export function assertFileContentAllowed(
  matcher: IgnoreMatcher,
  relativePath: string,
  isDirectory = false,
): void {
  const policy = evaluateFilePolicy(matcher, relativePath, isDirectory);
  if (policy.sensitive !== undefined) {
    throw new FileDomainError(
      'SENSITIVE_FILE',
      'Sensitive files are not exposed to the embedded renderer.',
    );
  }
  if (policy.ignored) {
    throw new FileDomainError(
      'IGNORED_FILE',
      'Ignored files are not exposed to the embedded renderer.',
    );
  }
}
