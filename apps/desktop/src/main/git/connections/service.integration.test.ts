import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  GitExecutor,
  GitRemoteConfigurationService,
  RepositoryService,
} from '@forgeboard/git-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import {
  GitConnectionMutationPlanViewSchema,
  GitConnectionsViewSchema,
} from '../../../shared/git/connections/index.js';
import {
  GitConnectionsService,
  type GitConnectionNativeReview,
  type GitConnectionsStore,
} from './service.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T14:00:00.000Z';
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe('GitConnectionsService with a real repository', () => {
  it('adds, replaces, and removes through admission while refreshing project health', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture);
    const initial = await harness.service.list({ projectId: PROJECT_ID });

    const add = await harness.service.prepareNetwork('window-a', {
      projectId: PROJECT_ID,
      operation: 'add',
      remoteName: 'origin',
      expectedRevision: initial.configurationRevision,
      url: 'https://example.invalid/owner/repository.git',
    });
    expect(() => GitConnectionMutationPlanViewSchema.parse(add)).not.toThrow();
    const added = await harness.service.confirm('window-a', add.planId, approve);
    expect(() => GitConnectionsViewSchema.parse(added)).not.toThrow();
    expect(await runGit(fixture, ['remote', 'get-url', 'origin'])).toBe(
      'https://example.invalid/owner/repository.git\n',
    );
    expect(harness.project().health.remotes).toEqual([
      { name: 'origin', url: 'HTTPS · example.invalid/owner/repository.git' },
    ]);

    const replace = await harness.service.prepareNetwork('window-a', {
      projectId: PROJECT_ID,
      operation: 'replace',
      remoteName: 'origin',
      expectedRevision: requiredView(added).configurationRevision,
      url: 'git@example.invalid:owner/replacement.git',
    });
    expect(replace).toMatchObject({
      operation: 'replace',
      before: { name: 'origin' },
      after: { transport: 'ssh', endpoint: 'example.invalid' },
      networkAccess: false,
    });
    const replaced = await harness.service.confirm('window-a', replace.planId, approve);
    expect(await runGit(fixture, ['remote', 'get-url', 'origin'])).toBe(
      'git@example.invalid:owner/replacement.git\n',
    );
    expect(harness.project().health.remotes[0]?.url).toBe(
      'SSH · example.invalid/owner/replacement.git',
    );

    await runGit(fixture, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const remove = await harness.service.prepareRemove('window-a', {
      projectId: PROJECT_ID,
      operation: 'remove',
      remoteName: 'origin',
      expectedRevision: requiredView(replaced).configurationRevision,
    });
    expect(remove).toMatchObject({
      operation: 'remove',
      after: null,
      remoteTrackingRefs: ['refs/remotes/origin/main'],
      networkAccess: false,
    });
    const removed = await harness.service.confirm('window-a', remove.planId, approve);
    expect(requiredView(removed).remotes).toEqual([]);
    expect(await runGit(fixture, ['remote'])).toBe('');
    expect(await runGit(fixture, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).toBe('');
    expect(harness.project().health.remotes).toEqual([]);

    expect(harness.admissionEvents).toEqual(['enter', 'exit', 'enter', 'exit', 'enter', 'exit']);
    expect(harness.saveProject).toHaveBeenCalledTimes(3);
    expect(harness.appendAudit.mock.calls.filter((call) => call[2] === 'allowed')).toHaveLength(3);
  });

  it('keeps selected local paths out of renderer views but exact in native review', async () => {
    const fixture = await createRepository();
    const localRemote = path.join(fixture.root, 'private local target.git');
    await mkdir(localRemote);
    await runGit(fixture, ['init', '--bare', localRemote]);
    const canonicalLocalRemote = await realpath(localRemote);
    const canonicalRepository = await realpath(fixture.repository);
    const harness = createHarness(fixture);
    const initial = await harness.service.list({ projectId: PROJECT_ID });
    const plan = await harness.service.prepareLocal(
      'window-a',
      {
        projectId: PROJECT_ID,
        operation: 'add',
        remoteName: 'backup',
        expectedRevision: initial.configurationRevision,
      },
      localRemote,
    );

    expect(plan.after).toMatchObject({
      kind: 'local-filesystem',
      endpoint: 'local-filesystem',
      resource: 'Local Git repository',
    });
    expect(JSON.stringify(plan)).not.toContain(canonicalLocalRemote);
    expect(JSON.stringify(plan)).not.toContain(canonicalRepository);

    const authorize = vi.fn((review: GitConnectionNativeReview) => {
      expect(review.view).toEqual(plan);
      expect(review.exactPlan.target).toMatchObject({
        kind: 'local-filesystem',
        exactUrl: canonicalLocalRemote,
        resource: canonicalLocalRemote,
      });
      return Promise.resolve('denied' as const);
    });
    await expect(harness.service.confirm('window-a', plan.planId, authorize)).resolves.toBeNull();
    expect(authorize).toHaveBeenCalledOnce();
    expect(await runGit(fixture, ['remote'])).toBe('');
    expect(harness.saveProject).not.toHaveBeenCalled();
  });

  it('detects real configuration drift both before and after native confirmation', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture);
    const initial = await harness.service.list({ projectId: PROJECT_ID });
    const staleBefore = await harness.service.prepareNetwork('window-a', {
      projectId: PROJECT_ID,
      operation: 'add',
      remoteName: 'origin',
      expectedRevision: initial.configurationRevision,
      url: 'https://example.invalid/owner/repository.git',
    });
    await runGit(fixture, ['remote', 'add', 'other', 'https://example.invalid/owner/other.git']);
    const unopened = vi.fn(() => Promise.resolve('approved' as const));

    await expect(harness.service.confirm('window-a', staleBefore.planId, unopened)).rejects.toThrow(
      /changed after review/iu,
    );
    expect(unopened).not.toHaveBeenCalled();
    expect(await runGit(fixture, ['remote'])).toBe('other\n');

    const current = await harness.service.list({ projectId: PROJECT_ID });
    const staleAfter = await harness.service.prepareNetwork('window-a', {
      projectId: PROJECT_ID,
      operation: 'add',
      remoteName: 'origin',
      expectedRevision: current.configurationRevision,
      url: 'https://example.invalid/owner/repository.git',
    });
    await expect(
      harness.service.confirm('window-a', staleAfter.planId, async () => {
        await runGit(fixture, ['config', 'remote.other.tagOpt', '--no-tags']);
        return 'approved';
      }),
    ).rejects.toThrow(/changed after review/iu);
    expect(await runGit(fixture, ['remote'])).toBe('other\n');
    expect(harness.saveProject).not.toHaveBeenCalled();
  });
});

function approve(): Promise<'approved'> {
  return Promise.resolve('approved');
}

function requiredView(view: Awaited<ReturnType<GitConnectionsService['confirm']>>) {
  if (view === null) throw new Error('Expected an approved Git connections view.');
  return view;
}

interface RepositoryFixture {
  readonly root: string;
  readonly repository: string;
  readonly home: string;
  readonly xdgConfigHome: string;
}

interface Harness {
  readonly service: GitConnectionsService;
  readonly admissionEvents: string[];
  readonly appendAudit: ReturnType<typeof vi.fn>;
  readonly saveProject: ReturnType<typeof vi.fn>;
  project(): Project;
}

function createHarness(fixture: RepositoryFixture): Harness {
  let currentProject = project(fixture.repository);
  const appendAudit = vi.fn();
  const saveProject = vi.fn((nextProject: Project) => {
    currentProject = nextProject;
    return nextProject;
  });
  const store: GitConnectionsStore = {
    getProject: (projectId) => (projectId === currentProject.id ? currentProject : undefined),
    saveProject,
    appendAudit,
  };
  const executor = new GitExecutor({
    environment: { HOME: fixture.home, XDG_CONFIG_HOME: fixture.xdgConfigHome },
  });
  const remotes = new GitRemoteConfigurationService(new RepositoryService(executor));
  const admissionEvents: string[] = [];
  const service = new GitConnectionsService(store, remotes, {
    now: () => new Date(NOW),
    withMutationAdmission: async <Output>(operation: () => Promise<Output>) => {
      admissionEvents.push('enter');
      try {
        return await operation();
      } finally {
        admissionEvents.push('exit');
      }
    },
  });
  return {
    service,
    admissionEvents,
    appendAudit,
    saveProject,
    project: () => currentProject,
  };
}

async function createRepository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-connections-'));
  fixtureRoots.push(root);
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  const xdgConfigHome = path.join(root, 'xdg');
  await Promise.all([mkdir(repository), mkdir(home), mkdir(xdgConfigHome)]);
  const fixture = { root, repository, home, xdgConfigHome };
  await runGit(fixture, ['init', '-b', 'main']);
  await runGit(fixture, ['config', 'user.name', 'Artemis Test']);
  await runGit(fixture, ['config', 'user.email', 'forgeboard@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# fixture\n', 'utf8');
  await runGit(fixture, ['add', '--', 'README.md']);
  await runGit(fixture, ['commit', '-m', 'Initial commit']);
  return fixture;
}

async function runGit(fixture: RepositoryFixture, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: fixture.repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fixture.home,
          XDG_CONFIG_HOME: fixture.xdgConfigHome,
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
          GIT_WORK_TREE: undefined,
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Connections fixture',
    path: repository,
    openedAt: NOW,
    missing: false,
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
