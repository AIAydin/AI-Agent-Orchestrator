// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunApprovalView } from '../../../../../shared/application/contracts.js';
import { RunApprovalDialog } from './RunApprovalDialog.js';

afterEach(cleanup);

describe('RunApprovalDialog', () => {
  it('shows the complete effective Custom policy and context binding before approval', () => {
    render(
      <RunApprovalDialog
        disclosure={customDisclosure()}
        prompt="Inspect the approved context."
        busy={false}
        onCancel={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Forgeboard has prepared this run, but no approved agent run has started.'),
    ).toBeTruthy();
    const permission = screen.getByRole('region', { name: 'Effective permission profile' });
    expect(within(permission).getByText(/Host disclosure-only policy/u)).toBeTruthy();
    expect(within(permission).getByText(/Ignored deny · sensitive allow/u)).toBeTruthy();
    expect(within(permission).getByText('/usr/local/bin/codex')).toBeTruthy();
    expect(within(permission).getByText(/Dev servers deny · tests allow · advisory/u)).toBeTruthy();
    expect(within(permission).getByText('Review always required')).toBeTruthy();
    expect(within(permission).getByText(/cwd is not an operating-system sandbox/u)).toBeTruthy();
    expect(screen.getByText('/tmp/worktrees/agent-1/src/app.ts')).toBeTruthy();
    expect(screen.getByText('e'.repeat(64))).toBeTruthy();
    expect(screen.getByText('context-manifest-1')).toBeTruthy();
    expect(screen.getByText('a'.repeat(64))).toBeTruthy();
    expect(screen.getByLabelText('Exact launch disclosure SHA-256').textContent).toBe(
      'f'.repeat(64),
    );
    expect(screen.getByLabelText('Approval expires at').getAttribute('datetime')).toBe(
      '2099-07-15T00:05:00.000Z',
    );
    expect(screen.getByRole('button', { name: 'Approve & launch' })).toBeTruthy();
  });
});

function customDisclosure(): RunApprovalView {
  return {
    runId: '00000000-0000-4000-8000-000000000010',
    nodeId: 'agent-1',
    adapterId: 'codex',
    provider: 'OpenAI',
    executable: '/usr/local/bin/codex',
    arguments: ['--sandbox', 'workspace-write'],
    cwd: '/tmp/worktrees/agent-1',
    runtime: 'pty',
    environmentVariableNames: ['PATH'],
    contextAttachments: [
      { path: '/tmp/worktrees/agent-1/src/app.ts', kind: 'file', sha256: 'e'.repeat(64) },
    ],
    contextManifestId: 'context-manifest-1',
    contextManifestDigest: 'a'.repeat(64),
    permissionProfile: {
      name: 'Custom host policy',
      mode: 'custom',
      enforcement: 'disclosure-only',
      readRoots: ['/tmp/worktrees/agent-1'],
      writeRoots: [],
      network: 'provider-controlled',
      custom: {
        runtime: 'host',
        filesystem: 'assigned-worktree-read-only',
        ignoredFileRead: 'deny',
        sensitiveFileRead: 'allow',
        launchExecutablePolicy: 'allowlist',
        allowedLaunchExecutables: ['/usr/local/bin/codex'],
        forgeboardManagedActions: { developmentServers: 'deny', tests: 'allow' },
        requireReviewBeforePrimary: true,
        policyLimitations: [
          'The host cwd is not an operating-system sandbox and descendants are not constrained.',
        ],
      },
    },
    warnings: ['Review the disclosure-only host boundary carefully.'],
    branch: 'forgeboard/task/codex-1',
    baseCommit: 'b'.repeat(40),
    primaryWasDirty: false,
    disclosureFingerprint: 'f'.repeat(64),
    expiresAt: '2099-07-15T00:05:00.000Z',
  };
}
