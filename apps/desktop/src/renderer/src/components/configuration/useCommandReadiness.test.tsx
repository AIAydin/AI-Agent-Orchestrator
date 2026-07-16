// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CheckCommandReadiness,
  CommandReadinessRequest,
  CommandReadinessResult,
} from '../../../../shared/command-readiness/contracts.js';
import { useCommandReadiness } from './useCommandReadiness.js';

afterEach(cleanup);

describe('useCommandReadiness', () => {
  it('discards evidence bound to different literal argv', async () => {
    const check: CheckCommandReadiness = (request) =>
      Promise.resolve(
        readyResult({
          ...request,
          command: { ...request.command, arguments: ['run', 'build'] },
        }),
      );
    render(<Harness check={check} />);

    expect(await screen.findByText(/discarded stale command evidence/u)).toBeTruthy();
    expect(screen.getByTestId('blocking-count').textContent).toBe('1');
  });

  it('replaces checking state only with exact current-command evidence', async () => {
    const check: CheckCommandReadiness = (request) => Promise.resolve(readyResult(request));
    render(<Harness check={check} />);

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    expect(screen.getByTestId('blocking-count').textContent).toBe('0');
  });
});

function Harness({ check }: { readonly check: CheckCommandReadiness }) {
  const readiness = useCommandReadiness(
    [
      {
        id: 'test',
        label: 'Tests',
        purpose: 'check',
        command: { executable: 'pnpm', arguments: ['run', 'test'] },
      },
    ],
    null,
    check,
  );
  const status = readiness.statuses['test'];
  return (
    <>
      <span data-testid="phase">{status?.phase}</span>
      <span>{status?.phase === 'unavailable' ? status.message : ''}</span>
      <span data-testid="blocking-count">{readiness.blockingIssues.length}</span>
    </>
  );
}

function readyResult(request: CommandReadinessRequest): CommandReadinessResult {
  return {
    schemaVersion: 1,
    request,
    state: 'ready-without-project',
    ready: true,
    validationScope: 'executable',
    resolvedExecutable: '/usr/local/bin/pnpm',
    projectName: null,
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason: null,
    warning: 'Open a project to validate the selected package script.',
  };
}
