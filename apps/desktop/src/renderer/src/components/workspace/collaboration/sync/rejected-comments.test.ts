import { describe, expect, it } from 'vitest';

import type { CollaborationCommentMetadata } from '../../../../../../shared/collaboration/index.js';
import { rejectedCommentsAfterAcknowledgement } from './rejected-comments.js';

const rejected: CollaborationCommentMetadata = {
  id: 'comment-b',
  nodeId: 'agent-1',
  authorId: 'editor-1',
  body: 'Exact rejected B',
  createdAt: '2026-07-15T12:00:00.000Z',
};

describe('rejectedCommentsAfterAcknowledgement', () => {
  it('retains B when acknowledged C omits it', () => {
    expect(rejectedCommentsAfterAcknowledgement([rejected], {})).toEqual([rejected]);
  });

  it('clears B when the correlated acknowledged candidate contains its exact value', () => {
    expect(rejectedCommentsAfterAcknowledgement([rejected], { [rejected.id]: rejected })).toEqual(
      [],
    );
  });

  it('retains exact B when acknowledged C reuses its id with a conflicting value', () => {
    expect(
      rejectedCommentsAfterAcknowledgement([rejected], {
        [rejected.id]: { ...rejected, body: 'Conflicting body' },
      }),
    ).toEqual([rejected]);
  });
});
