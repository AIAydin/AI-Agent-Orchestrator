import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createCustomCliAdapter,
  type CliAgentAdapter,
  type AgentEvent,
  type AgentResultMetadata,
  type AgentSession,
  type PermissionProfile,
} from '@forgeboard/agent-adapters';
import {
  ChangeService,
  RepositoryService,
  WorktreeService,
  type CleanupApproval,
  type CommitApproval,
  type MergeApproval,
  type WorktreeOwnership,
} from '@forgeboard/git-engine';
import {
  TEST_AGENT_MANIFEST,
  TestAgentEventSchema,
  createTestAgentRunCommand,
  type TestAgentAction,
  type TestAgentEvent,
} from '@forgeboard/test-agent';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const TSX_LOADER_URL = pathToFileURL(require.resolve('tsx/esm')).href;
const TEST_AGENT_CLI = fileURLToPath(
  new URL('../../../../packages/test-agent/src/cli.ts', import.meta.url),
);

interface TestRepository {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
}

interface SessionObservation {
  readonly events: readonly AgentEvent[];
  readonly messages: readonly TestAgentEvent[];
  readonly result: AgentResultMetadata;
}

function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...arguments_],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
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
        else reject(new Error(`git ${arguments_.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

async function createRepository(): Promise<TestRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-agent-git-'));
  const repository = path.join(root, 'repository');
  const managedRoot = path.join(root, 'managed-worktrees');
  await Promise.all([mkdir(repository), mkdir(managedRoot)]);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Forgeboard Integration Test']);
  await runGit(repository, ['config', 'user.email', 'forgeboard@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# agent fixture\n', 'utf8');
  await runGit(repository, ['add', '--', 'README.md']);
  await runGit(repository, ['commit', '-m', 'Initial commit']);
  return { root, repository, managedRoot };
}

function approvalBase(repositoryRoot: string, expectedHead: string) {
  return {
    approved: true as const,
    approvalId: randomUUID(),
    approvedAt: new Date().toISOString(),
    repositoryRoot,
    expectedHead,
  };
}

function permissionProfile(cwd: string): PermissionProfile {
  return {
    id: 'integration-worktree',
    name: 'Integration worktree',
    mode: 'custom',
    enforcement: 'disclosure-only',
    readRoots: [cwd],
    writeRoots: [cwd],
    network: 'blocked',
    approvalPolicy: 'The integration fixture approves only the disclosed worktree.',
    disclosure: 'The deterministic local test process may write only its assigned fixture.',
  };
}

function prepareTestAgent(
  adapter: CliAgentAdapter,
  cwd: string,
  actions: readonly TestAgentAction[],
) {
  return adapter.prepareLaunch({
    prompt: createTestAgentRunCommand(actions),
    cwd,
    permissionProfile: permissionProfile(cwd),
    contextAttachments: [],
    executable: process.execPath,
    extraArguments: ['--import', TSX_LOADER_URL, TEST_AGENT_CLI],
    environment: {
      inherit: 'safe',
      variables: { NODE_NO_WARNINGS: '1' },
      unset: [],
    },
  });
}

async function observeSession(
  session: AgentSession,
  onMessage?: (message: TestAgentEvent) => void,
): Promise<SessionObservation> {
  const events: AgentEvent[] = [];
  const messages: TestAgentEvent[] = [];
  const consume = (async () => {
    for await (const event of session.events) {
      events.push(event);
      if (event.type !== 'message') continue;
      const parsed = TestAgentEventSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      messages.push(parsed.data);
      onMessage?.(parsed.data);
    }
  })();
  const result = await session.result;
  await consume;
  return { events, messages, result };
}

async function commitAgentChanges(
  changes: ChangeService,
  repositories: RepositoryService,
  worktreePath: string,
  message: string,
): Promise<{ readonly commit: string; readonly changedPaths: readonly string[] }> {
  const status = await repositories.status(worktreePath);
  const changedPaths = status.entries
    .filter((entry) => entry.kind === 'untracked')
    .map((entry) => entry.path)
    .sort();
  expect(changedPaths).not.toHaveLength(0);

  const reviewDiff = await changes.prepareUntrackedForHunkReview(worktreePath, changedPaths);
  expect(reviewDiff.files.map((file) => file.newPath).sort()).toEqual(changedPaths);
  await changes.stagePaths(worktreePath, changedPaths);

  const snapshot = await changes.approvalSnapshot(worktreePath);
  const approval: CommitApproval = {
    action: 'commit',
    ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
    message,
    authorName: 'Forgeboard integration test',
    authorEmail: 'forgeboard-integration@example.invalid',
    stagedPaths: snapshot.stagedPaths,
    stagedPatchSha256: snapshot.stagedPatchSha256,
  };
  const committed = await changes.commit(worktreePath, approval);
  return { commit: committed.headAfter, changedPaths };
}

async function cleanupWorktree(
  worktrees: WorktreeService,
  ownership: WorktreeOwnership,
): Promise<void> {
  const impact = await worktrees.cleanupImpact(ownership);
  const approval: CleanupApproval = {
    action: 'cleanup-worktree',
    ...approvalBase(impact.ownership.repositoryRoot, impact.expectedHead),
    worktreeId: impact.ownership.id,
    worktreePath: impact.ownership.worktreePath,
    branch: impact.ownership.branch,
    expectedBranchOid: impact.branchOid,
    dirtyPaths: impact.dirtyPaths,
    deleteBranch: true,
    allowDirty: false,
    allowUnmergedBranch: false,
  };
  expect(await worktrees.cleanup(ownership, approval)).toEqual({
    worktreeRemoved: true,
    branchDeleted: true,
    metadataRemoved: true,
  });
}

describe('real deterministic agent and Git lifecycle', () => {
  const fixtureRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('runs two agent processes concurrently, reviews their diffs, commits, merges, and cleans up', async () => {
    const fixture = await createRepository();
    fixtureRoots.push(fixture.root);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const changes = new ChangeService(repositories);

    const [agentA, agentB] = await Promise.all([
      worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'deterministic-a',
        taskId: 'concurrent-agent-run',
      }),
      worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'deterministic-b',
        taskId: 'concurrent-agent-run',
      }),
    ]);
    expect(agentA.ownership.worktreePath).not.toBe(agentB.ownership.worktreePath);

    const adapterA = createCustomCliAdapter(TEST_AGENT_MANIFEST);
    const adapterB = createCustomCliAdapter(TEST_AGENT_MANIFEST);
    const [sessionA, sessionB] = await Promise.all([
      adapterA.launch(
        prepareTestAgent(adapterA, agentA.ownership.worktreePath, [
          { type: 'emit', stream: 'stdout', data: 'agent-a-started' },
          { type: 'sleep', milliseconds: 150 },
          { type: 'write-file', path: 'src/agent-a.txt', content: 'implementation A\n' },
          { type: 'complete', metadata: { agent: 'a', change: 'src/agent-a.txt' } },
        ]),
      ),
      adapterB.launch(
        prepareTestAgent(adapterB, agentB.ownership.worktreePath, [
          { type: 'emit', stream: 'stderr', data: 'agent-b-started' },
          { type: 'sleep', milliseconds: 150 },
          { type: 'write-file', path: 'docs/agent-b.txt', content: 'implementation B\n' },
          { type: 'complete', metadata: { agent: 'b', change: 'docs/agent-b.txt' } },
        ]),
      ),
    ]);
    expect(sessionA.pid).toBeTypeOf('number');
    expect(sessionB.pid).toBeTypeOf('number');
    expect(sessionA.pid).not.toBe(sessionB.pid);

    const [observedA, observedB] = await Promise.all([
      observeSession(sessionA),
      observeSession(sessionB),
    ]);
    for (const observation of [observedA, observedB]) {
      expect(observation.result).toMatchObject({ status: 'succeeded', exitCode: 0 });
      expect(observation.events.some((event) => event.type === 'stream')).toBe(true);
      expect(observation.events.at(-1)).toMatchObject({ type: 'result' });
      expect(observation.events.map((event) => event.sequence)).toEqual(
        observation.events.map((_, index) => index),
      );
      expect(observation.messages.map((message) => message.type)).toContain('file-written');
      expect(observation.messages.map((message) => message.type)).toContain('completed');
    }
    expect(observedA.messages).toContainEqual(
      expect.objectContaining({
        type: 'completed',
        metadata: { agent: 'a', change: 'src/agent-a.txt' },
      }),
    );
    expect(observedB.messages).toContainEqual(
      expect.objectContaining({
        type: 'completed',
        metadata: { agent: 'b', change: 'docs/agent-b.txt' },
      }),
    );

    const [acceptedA, acceptedB] = await Promise.all([
      commitAgentChanges(
        changes,
        repositories,
        agentA.ownership.worktreePath,
        'Accept deterministic agent A',
      ),
      commitAgentChanges(
        changes,
        repositories,
        agentB.ownership.worktreePath,
        'Accept deterministic agent B',
      ),
    ]);
    expect(acceptedA.changedPaths).toEqual(['src/agent-a.txt']);
    expect(acceptedB.changedPaths).toEqual(['docs/agent-b.txt']);

    const [comparisonA, comparisonB] = await Promise.all([
      changes.compareRefs(fixture.repository, 'main', agentA.ownership.branch),
      changes.compareRefs(fixture.repository, 'main', agentB.ownership.branch),
    ]);
    expect(comparisonA.commits).toEqual([acceptedA.commit]);
    expect(comparisonA.diff.files.map((file) => file.newPath)).toEqual(['src/agent-a.txt']);
    expect(comparisonB.commits).toEqual([acceptedB.commit]);
    expect(comparisonB.diff.files.map((file) => file.newPath)).toEqual(['docs/agent-b.txt']);

    const beforeFirstMerge = await changes.approvalSnapshot(fixture.repository);
    const mergeA: MergeApproval = {
      action: 'merge',
      ...approvalBase(beforeFirstMerge.repositoryRoot, beforeFirstMerge.expectedHead),
      sourceRef: agentA.ownership.branch,
      expectedSourceOid: acceptedA.commit,
      targetBranch: 'main',
      strategy: 'fast-forward-only',
    };
    expect((await changes.merge(fixture.repository, mergeA)).state).toBe('completed');

    const beforeSecondMerge = await changes.approvalSnapshot(fixture.repository);
    const mergeB: MergeApproval = {
      action: 'merge',
      ...approvalBase(beforeSecondMerge.repositoryRoot, beforeSecondMerge.expectedHead),
      sourceRef: agentB.ownership.branch,
      expectedSourceOid: acceptedB.commit,
      targetBranch: 'main',
      strategy: 'merge-commit',
    };
    expect((await changes.merge(fixture.repository, mergeB)).state).toBe('completed');
    await expect(readFile(path.join(fixture.repository, 'src/agent-a.txt'), 'utf8')).resolves.toBe(
      'implementation A\n',
    );
    await expect(readFile(path.join(fixture.repository, 'docs/agent-b.txt'), 'utf8')).resolves.toBe(
      'implementation B\n',
    );

    await cleanupWorktree(worktrees, agentA.ownership);
    await cleanupWorktree(worktrees, agentB.ownership);
    expect(await worktrees.listOwnership(fixture.managedRoot)).toEqual([]);
  });

  it('reports an interrupted run, then allows deterministic success and failure retries', async () => {
    const fixture = await createRepository();
    fixtureRoots.push(fixture.root);
    const adapter = createCustomCliAdapter(TEST_AGENT_MANIFEST);

    const interruptedSession = await adapter.launch(
      prepareTestAgent(adapter, fixture.repository, [
        { type: 'emit', stream: 'stdout', data: 'before-interrupt' },
        { type: 'sleep', milliseconds: 10_000 },
        { type: 'complete', metadata: { shouldNotComplete: true } },
      ]),
    );
    let interruptSent = false;
    const interrupted = await observeSession(interruptedSession, (message) => {
      if (message.type === 'run-started' && !interruptSent) {
        interruptSent = true;
        interruptedSession.interrupt();
      }
    });
    expect(interruptSent).toBe(true);
    expect(interrupted.result.status).toBe('interrupted');
    expect(interrupted.messages.map((message) => message.type)).toContain('interrupted');
    expect(interrupted.messages.map((message) => message.type)).not.toContain('completed');

    const retrySession = await adapter.launch(
      prepareTestAgent(adapter, fixture.repository, [
        { type: 'write-file', path: 'retry.txt', content: 'retry completed\n' },
        { type: 'complete', metadata: { attempt: 2 } },
      ]),
    );
    const retry = await observeSession(retrySession);
    expect(retry.result).toMatchObject({ status: 'succeeded', exitCode: 0 });
    await expect(readFile(path.join(fixture.repository, 'retry.txt'), 'utf8')).resolves.toBe(
      'retry completed\n',
    );

    const failedSession = await adapter.launch(
      prepareTestAgent(adapter, fixture.repository, [
        { type: 'fail', message: 'deterministic retry failure', exitCode: 7 },
      ]),
    );
    const failed = await observeSession(failedSession);
    expect(failed.result).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(failed.messages).toContainEqual(
      expect.objectContaining({
        type: 'failed',
        message: 'deterministic retry failure',
        exitCode: 7,
      }),
    );
  });
});
