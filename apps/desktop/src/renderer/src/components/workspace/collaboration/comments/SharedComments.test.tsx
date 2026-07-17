// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CollaborationRejectedCommentEntry } from '../../../../../../shared/collaboration/index.js';
import { SharedComments } from './SharedComments.js';

afterEach(cleanup);

describe('SharedComments', () => {
  it('lets an authorized reviewer author ordinary text without rendering markup', async () => {
    const onCreate = vi.fn(() => Promise.resolve(true));
    render(
      <SharedComments
        comments={[
          {
            id: 'comment-1',
            nodeId: 'node-1',
            authorId: 'reviewer-1',
            body: '<strong>plain text</strong>',
            createdAt: '2026-07-15T12:00:00.000Z',
          },
        ]}
        canComment
        onCreate={onCreate}
        onDiscardRejected={vi.fn().mockResolvedValue(false)}
      />,
    );

    expect(screen.getByText('<strong>plain text</strong>')).toBeTruthy();
    expect(document.querySelector('.shared-comments strong strong')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment' }), {
      target: { value: 'Please revise this.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Share comment' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Please revise this.'));
  });

  it('does not expose an authoring control to a viewer', () => {
    render(
      <SharedComments
        comments={[]}
        canComment={false}
        onCreate={vi.fn()}
        onDiscardRejected={vi.fn().mockResolvedValue(false)}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/can read comments but cannot add/u)).toBeTruthy();
  });

  it('describes shared comments as optional when a solo user has collaboration off', () => {
    render(
      <SharedComments
        comments={[]}
        roomEnabled={false}
        canComment={false}
        onCreate={vi.fn()}
        onDiscardRejected={vi.fn().mockResolvedValue(false)}
      />,
    );
    expect(screen.getByText(/Shared room comments are optional/u)).toBeTruthy();
    expect(screen.queryByText(/This role/u)).toBeNull();
  });

  it('restores exact text and separately confirms a value-bound local discard', async () => {
    const entry: CollaborationRejectedCommentEntry = {
      comment: {
        id: 'comment-rejected',
        nodeId: 'node-1',
        authorId: 'reviewer-1',
        body: 'Exact rejected text',
        createdAt: '2026-07-15T12:00:00.000Z',
      },
      rejectedDeliveryId: '00000000-0000-4000-8000-000000000097',
    };
    const onDiscardRejected = vi.fn<(entry: CollaborationRejectedCommentEntry) => Promise<boolean>>(
      () => Promise.resolve(true),
    );
    render(
      <SharedComments
        comments={[]}
        rejectedCommentEntries={[entry]}
        canComment
        onCreate={vi.fn()}
        onDiscardRejected={onDiscardRejected}
      />,
    );

    expect(screen.getByText('Exact rejected text')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore to editor' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Add a comment' }).value).toBe(
      'Exact rejected text',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard local copy' }));
    expect(onDiscardRejected).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard local copy' }));
    await waitFor(() => expect(onDiscardRejected).toHaveBeenCalledWith(entry));
  });
});
