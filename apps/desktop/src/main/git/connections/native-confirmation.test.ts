import type {
  GitConfiguredRemote,
  GitRemoteConfigurationPlan,
  GitRemoteTrackingRef,
} from '@forgeboard/git-engine';
import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { GitHubCliSelectionReview } from '../github-cli/runtime.js';
import { confirmGitConnectionMutation, confirmGitHubCliSelection } from './native-confirmation.js';
import type { GitConnectionNativeReview } from './service.js';
import { gitConnectionPlanView } from './views.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000002';
const LOCAL_PATH = '/Users/example/private/local-repository.git';
const parent = {} as BrowserWindow;

describe('native Git connection confirmation', () => {
  it('keeps the renderer view path-free while disclosing the exact local path natively', async () => {
    const review = localAddReview();
    const events: string[] = [];
    let shown: MessageBoxOptions | undefined;
    const dialog = {
      showMessageBox: vi.fn((_parent: BrowserWindow, options: MessageBoxOptions) => {
        events.push('show');
        shown = options;
        return Promise.resolve({ response: 1, checkboxChecked: false });
      }),
    } as unknown as Pick<Dialog, 'showMessageBox'>;

    expect(JSON.stringify(review.view)).not.toContain(LOCAL_PATH);
    expect(review.exactPlan.target).toMatchObject({
      kind: 'local-filesystem',
      exactUrl: LOCAL_PATH,
      resource: LOCAL_PATH,
    });
    await expect(
      confirmGitConnectionMutation(dialog, parent, review, () => events.push('current')),
    ).resolves.toBe('approved');

    expect(events).toEqual(['current', 'show', 'current']);
    expect(shown).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Add remote'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(shown?.detail).toContain(LOCAL_PATH);
    expect(shown?.detail).toContain('This change is local only');
  });

  it('fails before opening the dialog when native ownership is stale', async () => {
    const showMessageBox = vi.fn();
    const assertCurrent = vi.fn(() => {
      throw new Error('window changed');
    });

    await expect(
      confirmGitConnectionMutation(
        { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
        parent,
        localAddReview(),
        assertCurrent,
      ),
    ).rejects.toThrow(/window changed/iu);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('fails closed when native ownership changes while the dialog is open', async () => {
    const showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    let checks = 0;

    await expect(
      confirmGitConnectionMutation(
        { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
        parent,
        localAddReview(),
        () => {
          checks += 1;
          if (checks === 2) throw new Error('window changed');
        },
      ),
    ).rejects.toThrow(/window changed/iu);
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('uses cancel as the default and lists exact removal impact', async () => {
    const review = removeReview();
    let shown: MessageBoxOptions | undefined;
    const showMessageBox = vi.fn((_parent: BrowserWindow, options: MessageBoxOptions) => {
      shown = options;
      return Promise.resolve({ response: 0, checkboxChecked: false });
    });

    await expect(
      confirmGitConnectionMutation(
        { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
        parent,
        review,
        () => undefined,
      ),
    ).resolves.toBe('denied');
    expect(shown).toMatchObject({
      buttons: ['Cancel', 'Remove remote'],
      defaultId: 0,
      cancelId: 0,
    });
    expect(shown?.detail).toContain('removes the 2 remote settings');
    expect(shown?.detail).toContain('local: remote.origin.url');
    expect(shown?.detail).toContain('local: remote.origin.fetch');
    expect(shown?.detail).toContain(
      'Setting values are hidden because remote URLs can contain sign-in details',
    );
    expect(shown?.detail).toContain('refs/remotes/origin/main');
    expect(shown?.detail).toContain('nothing is fetched, pushed, or sent over the network');
  });

  it('describes replacement as one changed value without claiming every entry is unchanged', async () => {
    const add = localAddReview();
    const before = configuredRemote({
      name: 'refs/remotes/origin/main',
      oid: 'd'.repeat(40),
      symbolicTarget: null,
    });
    const exactPlan: GitRemoteConfigurationPlan = {
      ...add.exactPlan,
      kind: 'replace',
      name: 'origin',
      before,
      target: {
        kind: 'network',
        exactUrl: 'https://example.invalid/owner/replacement.git',
        transport: 'https',
        endpoint: 'example.invalid',
        resource: 'owner/replacement.git',
      },
    };
    const replacement = review(exactPlan);
    let shown: MessageBoxOptions | undefined;

    await confirmGitConnectionMutation(
      {
        showMessageBox: vi.fn((_parent: BrowserWindow, options: MessageBoxOptions) => {
          shown = options;
          return Promise.resolve({ response: 0, checkboxChecked: false });
        }),
      } as unknown as Pick<Dialog, 'showMessageBox'>,
      parent,
      replacement,
      () => undefined,
    );

    expect(shown?.detail).toContain('replaces one URL');
    expect(shown?.detail).toContain('The 2 reviewed settings otherwise stay unchanged');
    expect(shown?.detail).not.toContain('preserve all 2 existing configuration entries');
  });
});

describe('native GitHub CLI confirmation', () => {
  it('uses cancel-default review and exposes exact custom executable evidence only natively', async () => {
    const executablePath = '/Applications/tools/gh';
    const review: GitHubCliSelectionReview = {
      kind: 'github-cli-selection',
      planId: PLAN_ID,
      expiresAt: '2026-07-17T14:05:00.000Z',
      source: 'custom',
      candidate: {
        source: 'custom',
        filename: 'gh',
        sizeBytes: 42,
        sha256: 'e'.repeat(64),
        version: null,
      },
      networkAccess: false,
      executablePath,
      versionArguments: ['--version'],
    };
    let shown: MessageBoxOptions | undefined;
    const showMessageBox = vi.fn((_parent: BrowserWindow, options: MessageBoxOptions) => {
      shown = options;
      return Promise.resolve({ response: 1, checkboxChecked: false });
    });

    await expect(
      confirmGitHubCliSelection(
        { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
        parent,
        review,
        () => undefined,
      ),
    ).resolves.toBe('approved');
    expect(JSON.stringify({ ...review, executablePath: undefined })).not.toContain(executablePath);
    expect(shown).toMatchObject({
      buttons: ['Cancel', 'Use selected GitHub CLI'],
      defaultId: 0,
      cancelId: 0,
    });
    expect(shown?.detail).toContain(executablePath);
    expect(shown?.detail).toContain('e'.repeat(64));
    expect(shown?.detail).toContain('--version');
    expect(shown?.detail).toContain('This check stays on this computer');
  });

  it('reviews automatic missing mode without claiming code execution', async () => {
    const review: GitHubCliSelectionReview = {
      kind: 'github-cli-selection',
      planId: PLAN_ID,
      expiresAt: '2026-07-17T14:05:00.000Z',
      source: 'automatic',
      candidate: null,
      networkAccess: false,
      executablePath: null,
      versionArguments: null,
    };
    let shown: MessageBoxOptions | undefined;
    const showMessageBox = vi.fn((_parent: BrowserWindow, options: MessageBoxOptions) => {
      shown = options;
      return Promise.resolve({ response: 0, checkboxChecked: false });
    });

    await expect(
      confirmGitHubCliSelection(
        { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
        parent,
        review,
        () => undefined,
      ),
    ).resolves.toBe('denied');
    expect(shown?.detail).toContain('Version check: (none)');
    expect(shown?.detail).toContain('GitHub features stay unavailable');
  });
});

function localAddReview(): GitConnectionNativeReview {
  const plan: GitRemoteConfigurationPlan = {
    ...planBase(),
    kind: 'add',
    name: 'backup',
    before: null,
    target: {
      kind: 'local-filesystem',
      exactUrl: LOCAL_PATH,
      transport: 'local',
      endpoint: 'local-filesystem',
      resource: LOCAL_PATH,
    },
    removal: null,
  };
  return review(plan);
}

function removeReview(): GitConnectionNativeReview {
  const trackingRef: GitRemoteTrackingRef = {
    name: 'refs/remotes/origin/main',
    oid: 'd'.repeat(40),
    symbolicTarget: null,
  };
  const before = configuredRemote(trackingRef);
  const plan: GitRemoteConfigurationPlan = {
    ...planBase(),
    kind: 'remove',
    name: 'origin',
    before,
    target: null,
    removal: { configurationEntryCount: 2, trackingRefs: [trackingRef] },
  };
  return review(plan);
}

function review(plan: GitRemoteConfigurationPlan): GitConnectionNativeReview {
  return {
    exactPlan: plan,
    view: gitConnectionPlanView({
      planId: PLAN_ID,
      expiresAt: '2026-07-17T14:05:00.000Z',
      projectId: PROJECT_ID,
      projectName: 'Example project',
      plan,
    }),
  };
}

function planBase() {
  return {
    schemaVersion: 1 as const,
    repositoryRoot: '/projects/example',
    identity: {
      repositoryRoot: '/projects/example',
      commonDirectory: '/projects/example/.git',
      configurationPath: '/projects/example/.git/config',
      commonDirectoryDevice: '1',
      commonDirectoryInode: '2',
      configurationDevice: '1',
      configurationInode: '3',
    },
    configurationRevision: 'a'.repeat(64),
    networkAccess: false as const,
    planSha256: 'b'.repeat(64),
  };
}

function configuredRemote(trackingRef: GitRemoteTrackingRef): GitConfiguredRemote {
  const url = 'https://example.invalid/owner/repository.git';
  return {
    name: 'origin',
    entries: [
      {
        scope: 'local',
        origin: '/projects/example/.git/config',
        key: 'remote.origin.url',
        value: url,
      },
      {
        scope: 'local',
        origin: '/projects/example/.git/config',
        key: 'remote.origin.fetch',
        value: '+refs/heads/*:refs/remotes/origin/*',
      },
    ],
    urls: [url],
    pushUrls: [],
    fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
    target: {
      kind: 'network',
      exactUrl: url,
      transport: 'https',
      endpoint: 'example.invalid',
      resource: 'owner/repository.git',
    },
    targetState: 'supported',
    directLocalConfiguration: true,
    ambiguous: false,
    trackingRefCount: 1,
    trackingRefs: [trackingRef],
    trackingRefsTruncated: false,
  };
}
