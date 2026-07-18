// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CollaborationRejectedCommentEntry } from '../../../../../../shared/collaboration/index.js';
import { RejectedCommentActions } from './RejectedCommentActions.js';

afterEach(cleanup);

describe('RejectedCommentActions', () => {
  it('confirms the exact entry shown before a later identical rejection replaces it', async () => {
    const oldEntry = entry('00000000-0000-4000-8000-000000000097');
    const newerEntry = entry('00000000-0000-4000-8000-000000000098');
    const onDiscard = vi.fn().mockResolvedValue(false);
    const view = render(<RejectedCommentActions entry={oldEntry} onDiscard={onDiscard} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete saved copy' }));
    expect(
      screen.getByText(/leave and rejoin the shared canvas before sharing more changes/iu),
    ).toBeTruthy();
    view.rerender(<RejectedCommentActions entry={newerEntry} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete this copy' }));

    await waitFor(() => expect(onDiscard).toHaveBeenCalledWith(oldEntry));
    expect(onDiscard).not.toHaveBeenCalledWith(newerEntry);
  });
});

function entry(rejectedDeliveryId: string): CollaborationRejectedCommentEntry {
  return {
    comment: {
      id: 'comment-b',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Identical text',
      createdAt: '2026-07-15T12:00:00.000Z',
    },
    rejectedDeliveryId,
  };
}
