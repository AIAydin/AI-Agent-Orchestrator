// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentDetection, Project } from '../../../../../../shared/application/contracts.js';
import { WorkspaceStatusIndicators } from './WorkspaceStatusIndicators.js';

afterEach(cleanup);

describe('WorkspaceStatusIndicators', () => {
  it('makes solo locality, provider disclosure, and the dirty branch visible', () => {
    render(
      <WorkspaceStatusIndicators
        project={project(true)}
        projectStatusAvailable
        agents={agents()}
        collaborationEnabled={false}
        sharingStatus="not-connected"
      />,
    );

    const status = screen.getByRole('group', { name: 'Workspace status' });
    expect(status.textContent).toContain('Solo · local only');
    expect(status.textContent).toContain('Providers · approved context only');
    expect(status.textContent).toContain('main · modified');
    const sharing = screen.getByRole('status', { name: 'Solo · local only' });
    const branch = screen.getByRole('status', { name: 'main · modified' });
    expect(sharing.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', { name: /Solo mode is local/u }).id,
    );
    expect(branch.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', { name: 'Uncommitted changes on main' }).id,
    );
    fireEvent.click(screen.getByText('Providers · approved context only'));
    expect(screen.getByRole('note').textContent).toContain('Codex may contact OpenAI');
  });

  it('distinguishes connected sharing from an enabled offline room', () => {
    const view = render(
      <WorkspaceStatusIndicators
        project={project(false)}
        projectStatusAvailable
        agents={[]}
        collaborationEnabled
        sharingStatus="connected"
      />,
    );
    expect(screen.getByText('Sharing · connected')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();

    view.rerender(
      <WorkspaceStatusIndicators
        project={project(false)}
        projectStatusAvailable
        agents={[]}
        collaborationEnabled
        sharingStatus="offline"
      />,
    );
    expect(screen.getByText('Sharing · offline')).toBeTruthy();
  });

  it('does not claim stale branch health when the project cannot be verified', () => {
    render(
      <WorkspaceStatusIndicators
        project={project(false)}
        projectStatusAvailable={false}
        agents={[]}
        collaborationEnabled={false}
        sharingStatus="not-connected"
      />,
    );
    expect(screen.getByText('Git status unavailable')).toBeTruthy();
    expect(screen.queryByText('main')).toBeNull();
  });
});

function project(dirty: boolean): Project {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Fixture',
    path: '/tmp/fixture',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty,
      remotes: [],
      hasSubmodules: false,
      packageManager: 'unknown',
      scripts: {},
      frameworks: [],
      sensitiveWarnings: [],
    },
    openedAt: '2026-07-18T00:00:00.000Z',
  };
}

function agents(): AgentDetection[] {
  return [
    {
      id: 'codex',
      label: 'Codex',
      installed: true,
      executable: null,
      version: '1.0.0',
      providerDisclosure: 'Codex may contact OpenAI after approval.',
    },
  ];
}
