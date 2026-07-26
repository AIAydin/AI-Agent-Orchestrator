// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../../../shared/application/contracts.js';
import { ProjectSwitcher } from './ProjectSwitcher.js';

const recentMock = vi.fn();

beforeEach(() => {
  recentMock.mockReset();
  recentMock.mockResolvedValue({
    ok: true,
    value: [CURRENT, OTHER, MISSING],
  });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { projects: { recent: recentMock } },
  });
});

afterEach(cleanup);

describe('ProjectSwitcher', () => {
  it('opens a menu of recent projects instead of navigating away', async () => {
    const onSwitchProject = vi.fn();
    const onCloseProject = vi.fn();
    render(
      <ProjectSwitcher
        project={CURRENT}
        canvasName="Workshop"
        onSwitchProject={onSwitchProject}
        onNewProject={vi.fn()}
        onCloseProject={onCloseProject}
      />,
    );

    const trigger = screen.getByRole('button', { name: /earth-sim/u });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);
    expect(onCloseProject).not.toHaveBeenCalled();

    const menu = await screen.findByRole('menu', { name: 'Switch project' });
    expect(menu).toBeTruthy();
    await waitFor(() => expect(screen.getByText('mars-sim')).toBeTruthy());
    // The active and unreachable projects stay out of the list.
    expect(screen.queryByRole('menuitem', { name: /earth-sim/u })).toBeNull();
    expect(screen.queryByText('lost-project')).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: /mars-sim/u }));
    expect(onSwitchProject).toHaveBeenCalledWith(OTHER);
    expect(onCloseProject).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers New project… and Close project as explicit menu actions', async () => {
    const onNewProject = vi.fn();
    const onCloseProject = vi.fn();
    render(
      <ProjectSwitcher
        project={CURRENT}
        canvasName="Workshop"
        onSwitchProject={vi.fn()}
        onNewProject={onNewProject}
        onCloseProject={onCloseProject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /earth-sim/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New project…' }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(onCloseProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /earth-sim/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close project' }));
    expect(onCloseProject).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without acting', async () => {
    const onSwitchProject = vi.fn();
    render(
      <ProjectSwitcher
        project={CURRENT}
        canvasName="Workshop"
        onSwitchProject={onSwitchProject}
        onNewProject={vi.fn()}
        onCloseProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /earth-sim/u }));
    await screen.findByRole('menu');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onSwitchProject).not.toHaveBeenCalled();
  });
});

function project(id: string, name: string, missing = false): Project {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    openedAt: '2026-07-14T16:00:00.000Z',
    missing,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

const CURRENT = project('11111111-1111-4111-8111-111111111111', 'earth-sim');
const OTHER = project('22222222-2222-4222-8222-222222222222', 'mars-sim');
const MISSING = project('33333333-3333-4333-8333-333333333333', 'lost-project', true);
