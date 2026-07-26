import type { MessageBoxOptions } from 'electron';

import type { StoredGitReviewNote } from '../../../shared/git/reviews/contracts.js';
import { displayEscapedText } from '../../../shared/text/display-literal.js';

/** Cancel-default, path-free confirmation for one exact durable local review note. */
export function reviewNoteDeleteConfirmation(note: StoredGitReviewNote): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Delete review feedback?',
    message: 'Permanently delete this local review note?',
    detail: [
      `Kind: ${note.kind === 'revision-request' ? 'Revision request' : 'Line comment'}`,
      `Status: ${displayEscapedText(note.status)}`,
      `Note ID: ${displayEscapedText(note.id)}`,
      `Last updated: ${displayEscapedText(note.updatedAt)}`,
      '',
      'This removes the note from Artemis. It does not change Git files, commits, or branches.',
    ].join('\n'),
    buttons: ['Keep note', 'Delete note'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
