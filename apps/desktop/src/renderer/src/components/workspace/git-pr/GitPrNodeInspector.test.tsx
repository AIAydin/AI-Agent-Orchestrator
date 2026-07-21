// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitPrNodeInspector } from './GitPrNodeInspector.js';
import type {
  GitPrAgentRunOption,
  GitPrInspectionView,
  GitPrNodeConfiguration,
  GitPrNodeController,
  GitPrPendingPlan,
} from './types.js';

const RUN_ID = '20000000-0000-4000-8000-000000000001';
const SECOND_RUN_ID = '20000000-0000-4000-8000-000000000002';
const SOURCE_OID = 'a'.repeat(40);
const BASE_OID = 'b'.repeat(40);
const CURRENT_BASE_OID = 'd'.repeat(40);

const runs: readonly GitPrAgentRunOption[] = [
  {
    runId: RUN_ID,
    nodeLabel: 'Implement remote delivery',
    agentLabel: 'Deterministic test agent',
    status: 'succeeded',
    branch: 'forgeboard/remote-delivery',
    worktreeState: 'active',
    endedAt: '2026-07-17T01:00:00.000Z',
  },
  {
    runId: SECOND_RUN_ID,
    nodeLabel: 'Interrupted cleanup',
    agentLabel: 'Codex CLI',
    status: 'failed',
    branch: 'forgeboard/cleanup',
    worktreeState: 'cleanup-pending',
    endedAt: '2026-07-17T01:05:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('GitPrNodeInspector', () => {
  it('configures an owned terminal run and discloses exact local state without automatic effects', () => {
    const inspect = vi.fn();
    const onRecord = vi.fn();
    const controller = createController({ inspect, inspection: null });
    render(
      <InteractiveInspector
        controller={controller}
        onRecord={onRecord}
        initialConfiguration={configuration({
          targetRunId: undefined,
          destinationBranch: '',
        })}
      />,
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(controller.checkGitHub).not.toHaveBeenCalled();
    const target = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Finished agent run',
    });
    expect([...target.options].map((option) => option.text)).toEqual([
      'Choose a finished run…',
      'Implement remote delivery · Deterministic test agent · succeeded · forgeboard/remote-delivery',
      'Interrupted cleanup · Codex CLI · failed · cleanup interrupted · unavailable',
    ]);
    expect(target.options[2]).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Destination branch').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter the branch that should receive these changes.')).toBeTruthy();

    fireEvent.change(target, { target: { value: RUN_ID } });
    expect(screen.getByLabelText('Destination branch')).toHaveProperty(
      'value',
      'forgeboard/remote-delivery',
    );
    expect(screen.getByLabelText('Destination branch').getAttribute('aria-invalid')).toBe('false');
    fireEvent.change(screen.getByLabelText('Remote'), { target: { value: 'upstream' } });
    fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'develop' } });
    fireEvent.change(screen.getByLabelText('Pull request title'), {
      target: { value: 'Ship exact remote delivery' },
    });
    fireEvent.change(screen.getByLabelText('Pull request body'), {
      target: { value: 'Evidence-backed body' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create as a draft pull request' }));

    expect(onRecord).toHaveBeenCalledTimes(6);
    fireEvent.click(screen.getByRole('button', { name: 'Check changes' }));
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(controller.preparePush).not.toHaveBeenCalled();
    expect(controller.preparePullRequest).not.toHaveBeenCalled();
  });

  it('renders branch, full OIDs, commits, files, divergence, readiness, and on-demand controls', async () => {
    const onOpenReadiness = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const controller = createController({
      inspection: inspection(),
      githubStatus: {
        installed: true,
        version: '2.76.1',
        hostname: 'github.com',
        authenticated: true,
        ownerRepository: 'example/forgeboard',
        repositoryUrl: 'https://github.com/example/forgeboard',
        defaultBranch: 'main',
        sourceOid: SOURCE_OID,
        headMatchesSource: true,
        checkedAt: '2026-07-17T01:10:00.000Z',
        fresh: true,
      },
      ciStatus: {
        sourceOid: SOURCE_OID,
        checkedAt: '2026-07-17T01:11:00.000Z',
        runs: [
          {
            databaseId: 42,
            name: 'verify',
            workflowName: 'Verify',
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/example/forgeboard/actions/runs/42',
            headBranch: 'forgeboard/remote-delivery',
            headSha: SOURCE_OID,
          },
        ],
      },
    });
    renderInspector({ controller, onOpenReadiness });

    const exact = screen.getByRole('region', { name: 'Check results' });
    expectText(
      exact,
      'forgeboard/remote-delivery',
      SOURCE_OID,
      BASE_OID,
      CURRENT_BASE_OID,
      '1 ahead · 0 behind',
      '2 files · +18 −3',
      'src/old.ts → src/new.ts',
      'README.md',
      'All exact local checks passed.',
    );
    expectText(exact, "Base branch's latest commit", 'Compared with base branch now');
    expectText(
      screen.getByRole('region', { name: 'GitHub sign-in and repository status' }),
      'example/forgeboard',
    );
    expectText(
      screen.getByRole('region', { name: 'CI results for this commit' }),
      'completed · success',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy run URL' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'https://github.com/example/forgeboard/actions/runs/42',
      ),
    );
    expect(screen.getByText('Link copied to the clipboard.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Review push' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open checks and approval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check GitHub sign-in and repository' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review pull request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check CI results for this commit' }));
    expect(controller.preparePush).toHaveBeenCalledTimes(1);
    expect(onOpenReadiness).toHaveBeenCalledWith(RUN_ID);
    expect(controller.checkGitHub).toHaveBeenCalledTimes(1);
    expect(controller.preparePullRequest).toHaveBeenCalledTimes(1);
    expect(controller.checkCi).toHaveBeenCalledTimes(1);
  });

  it('requires a second review and preserves cancel-default language before push or PR effects', () => {
    const pushPlan: GitPrPendingPlan = {
      kind: 'push',
      planId: 'push-plan-1',
      expiresAt: '2026-07-17T01:20:00.000Z',
      inspection: inspection(),
    };
    const cancelPlan = vi.fn();
    const confirmPlan = vi.fn();
    const view = renderInspector({
      controller: createController({ pendingPlan: pushPlan, cancelPlan, confirmPlan }),
    });

    let dialog = screen.getByRole('alertdialog', { name: 'Review the push' });
    expectText(
      dialog,
      'Nothing has changed online yet',
      SOURCE_OID,
      '2',
      'Force push is never offered',
    );
    expectText(
      within(dialog).getByRole('region', { name: 'Commits and changed files' }),
      SOURCE_OID,
      'src/old.ts → src/new.ts',
      'README.md',
    );
    const goBack = within(dialog).getByRole('button', { name: 'Go back' });
    const continueButton = within(dialog).getByRole('button', {
      name: 'Continue to final confirmation',
    });
    expect(document.activeElement).toBe(goBack);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(continueButton);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(goBack);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelPlan).toHaveBeenCalledTimes(1);
    expect(confirmPlan).not.toHaveBeenCalled();

    const pullRequestPlan: GitPrPendingPlan = {
      kind: 'pull-request',
      planId: 'pr-plan-1',
      expiresAt: '2026-07-17T01:21:00.000Z',
      inspection: inspection(),
      ownerRepository: 'example/forgeboard',
      title: 'Ship remote delivery',
      body: 'Exact evidence',
      draft: true,
    };
    view.rerender(
      <GitPrNodeInspector
        {...baseProps()}
        controller={createController({
          pendingPlan: pullRequestPlan,
          cancelPlan,
          confirmPlan,
        })}
      />,
    );
    dialog = screen.getByRole('alertdialog', { name: 'Review the pull request' });
    expect(within(dialog).getByText(/commits pushed later change/iu)).toBeTruthy();
    expectText(dialog, 'example/forgeboard', 'Ship remote delivery', 'Exact evidence', 'Draft');
    expectText(
      within(dialog).getByRole('region', { name: 'Commits and changed files' }),
      SOURCE_OID,
      'src/old.ts → src/new.ts',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to final confirmation' }));
    expect(confirmPlan).toHaveBeenCalledTimes(1);
  });

  it('disables configuration and every remote effect when locked or collaboration-read-only', () => {
    const controller = createController({
      inspection: inspection(),
      githubStatus: {
        installed: true,
        version: '2.76.1',
        hostname: 'github.com',
        authenticated: true,
        ownerRepository: 'example/forgeboard',
        repositoryUrl: 'https://github.com/example/forgeboard',
        defaultBranch: 'main',
        sourceOid: SOURCE_OID,
        headMatchesSource: true,
        checkedAt: '2026-07-17T01:10:00.000Z',
        fresh: true,
      },
      pendingPlan: {
        kind: 'push',
        planId: 'push-plan-1',
        expiresAt: '2026-07-17T01:20:00.000Z',
        inspection: inspection(),
      },
    });
    const view = renderInspector({ controller, locked: true });

    expect(screen.getByText(/Unlock this node/u)).toBeTruthy();
    expect(screen.getByLabelText('Remote').closest('fieldset')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Review push' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Open checks and approval' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      screen.getByRole('button', { name: 'Check GitHub sign-in and repository' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Review pull request' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Check CI results for this commit' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Continue to final confirmation' })).toHaveProperty(
      'disabled',
      true,
    );

    view.rerender(
      <GitPrNodeInspector
        {...baseProps()}
        locked={false}
        configurationReadOnly
        controller={controller}
      />,
    );
    expect(screen.getByText(/Your role can view these publish settings/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review push' })).toHaveProperty('disabled', true);
  });

  it('keeps stale CI and invalid saved links visibly non-authoritative', () => {
    const controller = createController({
      inspection: inspection(),
      githubStatus: {
        installed: false,
        version: null,
        hostname: 'github.com',
        authenticated: false,
        ownerRepository: null,
        repositoryUrl: null,
        defaultBranch: null,
        sourceOid: SOURCE_OID,
        headMatchesSource: false,
        checkedAt: '2026-07-17T01:10:00.000Z',
        fresh: true,
      },
      ciStatus: {
        sourceOid: 'c'.repeat(40),
        checkedAt: '2026-07-17T01:11:00.000Z',
        runs: [],
      },
    });
    renderInspector({
      controller,
      configuration: configuration({ pullRequestUrl: 'javascript:alert(1)' }),
    });

    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.getByText(/Push still works without it/u)).toBeTruthy();
    expectText(
      screen.getByRole('region', { name: 'CI results for this commit' }),
      'These results are for an earlier commit',
    );
    expectText(
      screen.getByRole('region', { name: 'Created pull request' }),
      "isn't valid, so it can't be opened",
    );
    expect(screen.queryByRole('button', { name: 'Copy pull request URL' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Review pull request' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps persisted run loading and failure states honest without a false empty state', () => {
    const view = renderInspector({
      controller: createController({
        agentRuns: [],
        agentRunsLoaded: false,
        agentRunsError: null,
        inspection: null,
      }),
    });

    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Finished agent run' }).value,
    ).toBe(RUN_ID);
    expect(screen.getByText('Saved run · loading run history…')).toBeTruthy();
    expect(screen.queryByText(/not in the recent list/u)).toBeNull();

    view.rerender(
      <GitPrNodeInspector
        {...baseProps()}
        controller={createController({
          agentRuns: [],
          agentRunsLoaded: true,
          agentRunsError: 'Local run history is temporarily unavailable.',
          inspection: null,
        })}
      />,
    );
    expect(screen.getByText('Saved run · run history unavailable')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'Local run history is temporarily unavailable.',
    );
    expect(screen.queryByText(/No finished runs to publish yet/u)).toBeNull();
  });

  it('offers inspected remote names without overwriting a missing saved value', () => {
    const view = renderInspector({
      controller: createController({ availableRemotes: ['origin', 'upstream'], inspection: null }),
      configuration: configuration({ remote: 'saved-fork' }),
    });
    const remote = screen.getByLabelText<HTMLInputElement>('Remote');
    const optionsId = remote.getAttribute('list');
    expect(optionsId).toBe('node-git-pr-node-git-pr-remote-options');
    expect(
      [...(document.getElementById(optionsId ?? '')?.querySelectorAll('option') ?? [])].map(
        (option) => option.getAttribute('value'),
      ),
    ).toEqual(['origin', 'upstream']);
    expect(remote.value).toBe('saved-fork');
    expect(remote.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/No remote named saved-fork was found/u)).toBeTruthy();

    view.rerender(
      <GitPrNodeInspector
        {...baseProps()}
        controller={createController({ availableRemotes: [], inspection: null })}
        configuration={configuration({ remote: 'origin' })}
      />,
    );
    expect(screen.getByText(/No remotes were found/u)).toBeTruthy();
  });

  it('explains invalid fields before review and keeps prior pull requests non-authoritative', () => {
    const controller = createController({
      inspection: inspection(),
      githubStatus: {
        installed: true,
        version: '2.76.1',
        hostname: 'github.com',
        authenticated: true,
        ownerRepository: 'example/forgeboard',
        repositoryUrl: 'https://github.com/example/forgeboard',
        defaultBranch: 'main',
        sourceOid: SOURCE_OID,
        headMatchesSource: true,
        checkedAt: '2026-07-17T01:10:00.000Z',
        fresh: true,
      },
    });
    renderInspector({
      controller,
      configuration: configuration({
        remote: 'bad/name',
        destinationBranch: 'bad branch',
        baseBranch: '@',
        pullRequestTitle: '   ',
        pullRequestBody: '',
        pullRequestUrl: 'https://github.com/example/forgeboard/pull/42',
      }),
    });

    expect(screen.getByLabelText('Remote').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Destination branch').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Base branch').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Pull request title').getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById('node-git-pr-node-git-pr-body-count')?.textContent).toMatch(
      /0\s*\/\s*32,768\s+characters/u,
    );
    expect(screen.getByRole('button', { name: 'Review pull request' })).toHaveProperty(
      'disabled',
      true,
    );
    const lastPullRequest = screen.getByRole('region', { name: 'Created pull request' });
    expect(lastPullRequest.textContent).toContain('Last created pull request');
    expect(lastPullRequest.textContent).toContain('may have changed since');
  });
});

function InteractiveInspector({
  controller,
  initialConfiguration,
  onRecord,
}: {
  readonly controller: GitPrNodeController;
  readonly initialConfiguration: GitPrNodeConfiguration;
  readonly onRecord: () => void;
}) {
  const [current, setCurrent] = useState(initialConfiguration);
  return (
    <GitPrNodeInspector
      {...baseProps()}
      configuration={current}
      controller={controller}
      onRecord={onRecord}
      onConfigurationChange={(patch) => setCurrent((value) => ({ ...value, ...patch }))}
    />
  );
}

function renderInspector(
  options: {
    readonly controller?: GitPrNodeController;
    readonly configuration?: GitPrNodeConfiguration;
    readonly locked?: boolean;
    readonly configurationReadOnly?: boolean;
    readonly onOpenReadiness?: (runId: string) => void;
  } = {},
) {
  return render(
    <GitPrNodeInspector
      {...baseProps()}
      controller={options.controller ?? createController()}
      configuration={options.configuration ?? configuration()}
      locked={options.locked ?? false}
      configurationReadOnly={options.configurationReadOnly ?? false}
      onOpenReadiness={options.onOpenReadiness ?? vi.fn()}
    />,
  );
}

function baseProps() {
  return {
    projectName: 'Forgeboard demo',
    nodeId: 'git-pr-node',
    locked: false,
    configurationReadOnly: false,
    configuration: configuration(),
    controller: createController(),
    onRecord: vi.fn(),
    onConfigurationChange: vi.fn(),
    onOpenReadiness: vi.fn(),
  };
}

function configuration(overrides: Partial<GitPrNodeConfiguration> = {}): GitPrNodeConfiguration {
  return {
    targetRunId: RUN_ID,
    remote: 'origin',
    destinationBranch: 'forgeboard/remote-delivery',
    baseBranch: 'main',
    pullRequestTitle: 'Ship remote delivery',
    pullRequestBody: 'Exact evidence',
    pullRequestDraft: false,
    ...overrides,
  };
}

function inspection(overrides: Partial<GitPrInspectionView> = {}): GitPrInspectionView {
  return {
    targetRunId: RUN_ID,
    sourceBranch: 'forgeboard/remote-delivery',
    sourceOid: SOURCE_OID,
    remote: 'origin',
    remoteDisclosure: 'https://github.com/example/forgeboard.git',
    destinationBranch: 'forgeboard/remote-delivery',
    requestedBaseBranch: 'main',
    requestedBaseOid: null,
    runBaseRef: 'refs/heads/main',
    runBaseOid: BASE_OID,
    divergenceBaseOid: CURRENT_BASE_OID,
    commitCount: 2,
    commits: [SOURCE_OID, 'c'.repeat(40)],
    commitsTruncated: false,
    fileCount: 2,
    files: [
      { status: 'renamed', oldPath: 'src/old.ts', newPath: 'src/new.ts' },
      { status: 'modified', oldPath: 'README.md', newPath: 'README.md' },
    ],
    filesTruncated: false,
    additions: 18,
    deletions: 3,
    ahead: 1,
    behind: 0,
    ready: true,
    readiness: ['All exact local checks passed.'],
    inspectedAt: '2026-07-17T01:09:00.000Z',
    ...overrides,
  };
}

function createController(overrides: Partial<GitPrNodeController> = {}): GitPrNodeController {
  return {
    agentRuns: runs,
    agentRunsLoaded: true,
    agentRunsError: null,
    availableRemotes: ['origin'],
    inspection: inspection(),
    inspectionError: null,
    githubStatus: null,
    githubError: null,
    ciStatus: null,
    ciError: null,
    actionError: null,
    pendingPlan: null,
    busy: null,
    notice: null,
    refreshAgentRuns: vi.fn(),
    inspect: vi.fn(),
    preparePush: vi.fn(),
    checkGitHub: vi.fn(),
    preparePullRequest: vi.fn(),
    checkCi: vi.fn(),
    cancelPlan: vi.fn(),
    confirmPlan: vi.fn(),
    ...overrides,
  };
}

function expectText(element: HTMLElement, ...values: readonly string[]): void {
  for (const value of values) expect(element.textContent).toContain(value);
}
