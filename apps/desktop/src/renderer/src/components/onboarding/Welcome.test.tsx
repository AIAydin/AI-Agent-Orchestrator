// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Project,
  ProjectRecoveryAssessment,
} from '../../../../shared/application/contracts.js';
import { Welcome } from './Welcome.js';

const PROJECT_ID = 'c95b77bb-53d0-46f9-b9fc-5df23c0d5843';
const CONFIRMATION_ID = '123fae6e-e213-4a10-a0db-0f85b791f7e9';

afterEach(cleanup);

const health = {
  isGitRepository: true,
  branch: 'main',
  dirty: false,
  remotes: [{ name: 'origin', url: 'https://github.com/example/project.git' }],
  packageManager: 'pnpm' as const,
  frameworks: ['React'],
  scripts: { test: 'vitest' },
  hasSubmodules: false,
  sensitiveWarnings: [],
};

const missingProject: Project = {
  id: PROJECT_ID,
  name: 'Lost repository',
  path: '/old/project',
  openedAt: '2026-07-14T16:00:00.000Z',
  missing: true,
  health,
};

const assessment: ProjectRecoveryAssessment = {
  confirmationId: CONFIRMATION_ID,
  expiresAt: '2026-07-14T16:15:00.000Z',
  projectId: PROJECT_ID,
  original: { name: missingProject.name, path: missingProject.path, health },
  candidate: { name: 'Moved repository', path: '/new/project', health },
  warnings: ['The candidate does not share a known remote with the previous location.'],
};

function props(
  overrides: Partial<ComponentProps<typeof Welcome>> = {},
): ComponentProps<typeof Welcome> {
  return {
    recent: [missingProject],
    agents: [],
    busy: false,
    onOpen: vi.fn(),
    onOpenRecent: vi.fn(),
    onLocateMoved: vi.fn(() => Promise.resolve(assessment)),
    onConfirmMoved: vi.fn(() => Promise.resolve()),
    onError: vi.fn(),
    onCreate: vi.fn(),
    onClone: vi.fn(),
    onDemo: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

describe('Welcome moved-project recovery', () => {
  it('marks a missing project, prevents blind open, and requires reviewed confirmation', async () => {
    const onOpenRecent = vi.fn();
    const onLocateMoved = vi.fn(() => Promise.resolve(assessment));
    const onConfirmMoved = vi.fn(() => Promise.resolve());
    render(<Welcome {...props({ onOpenRecent, onLocateMoved, onConfirmMoved })} />);

    expect(screen.getByText('Missing folder')).toBeTruthy();
    fireEvent.click(screen.getByText('Lost repository'));
    expect(onOpenRecent).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Locate moved repository for Lost repository' }),
    );
    await waitFor(() => expect(onLocateMoved).toHaveBeenCalledWith(PROJECT_ID));

    const dialog = await screen.findByRole('dialog', { name: 'Confirm moved project' });
    expect(within(dialog).getByText('/old/project')).toBeTruthy();
    expect(within(dialog).getByText('/new/project')).toBeTruthy();
    expect(within(dialog).getByText('Git repository')).toBeTruthy();
    expect(within(dialog).getByText('origin: https://github.com/example/project.git')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'does not share a known remote',
    );
    expect(onConfirmMoved).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm new location' }));
    await waitFor(() =>
      expect(onConfirmMoved).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        confirmationId: CONFIRMATION_ID,
        confirmed: true,
      }),
    );
  });

  it('opens an available recent project normally', () => {
    const onOpenRecent = vi.fn();
    render(
      <Welcome
        {...props({
          recent: [{ ...missingProject, missing: false }],
          onOpenRecent,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Lost repository/ }));
    expect(onOpenRecent).toHaveBeenCalledWith('/old/project');
    expect(screen.queryByText('Missing folder')).toBeNull();
  });

  it('does not show a confirmation or mutate when native selection fails', async () => {
    const onError = vi.fn();
    const onConfirmMoved = vi.fn(() => Promise.resolve());
    render(
      <Welcome
        {...props({
          onLocateMoved: vi.fn(() => Promise.reject(new Error('Candidate was rejected.'))),
          onConfirmMoved,
          onError,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Locate moved repository for Lost repository' }),
    );
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Candidate was rejected.'));
    expect(screen.queryByRole('dialog', { name: 'Confirm moved project' })).toBeNull();
    expect(onConfirmMoved).not.toHaveBeenCalled();
  });
});
