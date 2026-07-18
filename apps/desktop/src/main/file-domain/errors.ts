import { PathPolicyError } from '@forgeboard/core';
import { ZodError } from 'zod';

import type { FileDomainErrorCode } from '../../shared/files/contracts.js';

export class FileDomainError extends Error {
  public constructor(
    public readonly code: FileDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileDomainError';
  }
}

export function normalizeFileDomainError(cause: unknown): FileDomainError {
  if (cause instanceof FileDomainError) return cause;
  if (cause instanceof ZodError) {
    return new FileDomainError('INVALID_REQUEST', 'The requested local file operation is invalid.');
  }
  if (cause instanceof PathPolicyError) {
    switch (cause.code) {
      case 'ROOT_NOT_FOUND':
        return new FileDomainError(
          'PROJECT_ROOT_UNAVAILABLE',
          'The selected project folder is no longer available.',
        );
      case 'PATH_NOT_FOUND':
        return new FileDomainError('FILE_NOT_FOUND', 'The selected project file no longer exists.');
      case 'PATH_ESCAPE':
        return new FileDomainError(
          'PATH_OUTSIDE_PROJECT',
          'Forgeboard blocked a path outside the selected project.',
        );
      case 'DEVICE_PATH':
      case 'INVALID_PATH':
        return new FileDomainError(
          'INVALID_REQUEST',
          'Forgeboard blocked an invalid local file path.',
        );
    }
  }

  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FileDomainError('FILE_NOT_FOUND', 'The selected project file no longer exists.');
  }
  if (code === 'ELOOP') {
    return new FileDomainError(
      'SYMLINK_BLOCKED',
      'Forgeboard cannot open symbolic links (file shortcuts) in the editor.',
    );
  }
  return new FileDomainError('IO_ERROR', 'Forgeboard could not complete the local file operation.');
}

export async function fileDomainBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw normalizeFileDomainError(cause);
  }
}
