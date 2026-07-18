// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalComments } from './LocalComments.js';

afterEach(cleanup);

describe('LocalComments', () => {
  it('clearly labels private storage and saves without collaboration authority', () => {
    const onCreate = vi.fn(() => true);
    render(<LocalComments comments={[]} onCreate={onCreate} />);

    expect(screen.getByText(/Joining or leaving a shared room never shares/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add a private comment'), {
      target: { value: 'Private implementation note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save locally' }));

    expect(onCreate).toHaveBeenCalledWith('Private implementation note');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Add a private comment').value).toBe('');
  });

  it('renders only the provided local comments', () => {
    render(
      <LocalComments
        comments={[
          {
            id: 'local:1',
            authorId: 'local-user',
            scope: 'local',
            body: 'Visible only here',
            createdAt: '2026-07-17T12:00:00.000Z',
          },
        ]}
        onCreate={() => true}
      />,
    );
    expect(screen.getByText('Visible only here')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });
});
