// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CollaborationRejectedCommentEntry } from '../../../../../../shared/collaboration/index.js';
import { RejectedCommentsNotice } from './RejectedCommentsNotice.js';

afterEach(cleanup);

describe('RejectedCommentsNotice', () => {
  it('lets every role explicitly discard exact retained text when its target is unavailable', async () => {
    const entry: CollaborationRejectedCommentEntry = {
      comment: {
        id: 'comment-b',
        nodeId: 'removed-node',
        authorId: 'editor-1',
        body: '<strong>Exact rejected B</strong>',
        createdAt: '2026-07-15T12:00:00.000Z',
      },
      rejectedDeliveryId: '00000000-0000-4000-8000-000000000097',
    };
    const onDiscard = vi.fn<(entry: CollaborationRejectedCommentEntry) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    render(<RejectedCommentsNotice entries={[entry]} onDiscard={onDiscard} />);

    expect(screen.getByText('<strong>Exact rejected B</strong>')).toBeTruthy();
    expect(screen.getByText('Canvas item: removed-node')).toBeTruthy();
    expect(document.querySelector('.rejected-comments-notice strong strong')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved copy' }));
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete this copy' }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalledWith(entry));
  });
});
