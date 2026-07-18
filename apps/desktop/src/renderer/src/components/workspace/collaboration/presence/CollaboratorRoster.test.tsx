// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CollaboratorRoster } from './CollaboratorRoster.js';

afterEach(cleanup);

describe('CollaboratorRoster', () => {
  it('shows an idle collaborator with no cursor or selection', () => {
    render(
      <CollaboratorRoster
        awareness={[
          {
            clientId: 7,
            state: {
              user: {
                id: 'reviewer-1',
                displayName: 'Idle Reviewer',
                color: '#6d5efc',
                role: 'reviewer',
              },
              activity: { status: 'idle' },
            },
          },
        ]}
      />,
    );

    expect(screen.getByLabelText('Idle Reviewer, reviewer, not active right now').textContent).toBe(
      'IR',
    );
  });

  it('bounds visible avatars and reports overflow', () => {
    render(
      <CollaboratorRoster
        awareness={Array.from({ length: 14 }, (_, index) => ({
          clientId: index,
          state: {
            user: {
              id: `peer-${index}`,
              displayName: `Peer ${index}`,
              color: '#6d5efc',
              role: 'editor' as const,
            },
            activity: { status: 'idle' as const },
          },
        }))}
      />,
    );

    expect(screen.getByLabelText('2 more people')).toBeTruthy();
  });
});
