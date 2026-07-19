import type { MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { PendingConflictFileResolution } from './conflict-file-service.js';

export function conflictFileConfirmation(plan: PendingConflictFileResolution): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Apply and stage this conflict resolution?',
    message: `Replace and stage ${displayLiteral(plan.path)}?`,
    detail: [
      `Operation: ${plan.operation}`,
      `Workspace: ${plan.target.kind === 'primary' ? 'primary checkout' : 'managed agent workspace'}`,
      `Current content SHA-256: ${plan.expectedSha256}`,
      `Resolved content SHA-256: ${plan.resolvedSha256}`,
      `Resolved size: ${String(plan.sizeBytes)} bytes`,
      '',
      'Forgeboard will refuse if the operation, conflicted path, file content, or workspace changed after review.',
      'The exact reviewed UTF-8 content will replace this one file and Git will stage that path. Nothing is committed automatically.',
    ].join('\n'),
    buttons: ['Cancel', 'Apply and stage resolution'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
