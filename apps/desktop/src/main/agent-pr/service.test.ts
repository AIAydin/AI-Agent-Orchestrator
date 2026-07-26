import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Project } from '../../shared/application/contracts.js';
import type { StoredRunRecord } from '../storage-schemas.js';
import {
  AGENT_PR_COMMIT_MESSAGE,
  AgentSessionPrService,
  pullRequestUrl,
  type AgentPrExec,
} from './service.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '60000000-0000-4000-8000-000000000001';
const NODE_ID = 'agent-one';

interface RecordedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

function harness(options: {
  readonly statusOutput?: string;
  readonly runRecord?: Partial<StoredRunRecord> | null;
  readonly projectPath?: string;
  readonly failCommand?: { readonly argsPrefix: string; readonly stderr: string };
}) {
  const projectPath = options.projectPath ?? process.cwd();
  const commands: RecordedCommand[] = [];
  const exec: AgentPrExec = (file, args, execOptions) => {
    commands.push({ file, args, cwd: execOptions.cwd });
    if (options.failCommand !== undefined && args[0] === options.failCommand.argsPrefix) {
      const failure = Object.assign(new Error('command failed'), {
        stderr: options.failCommand.stderr,
      });
      return Promise.reject(failure);
    }
    if (args[0] === 'status') {
      return Promise.resolve({ stdout: options.statusOutput ?? '', stderr: '' });
    }
    if (args[0] === 'rev-parse') {
      return Promise.resolve({ stdout: 'feature/current\n', stderr: '' });
    }
    if (args[0] === 'pr') {
      return Promise.resolve({
        stdout: 'Creating pull request…\nhttps://github.com/acme/app/pull/42\n',
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  const project = {
    id: PROJECT_ID,
    name: 'Fixture',
    path: projectPath,
    missing: false,
  } as Project;
  const record: StoredRunRecord | undefined =
    options.runRecord === null
      ? undefined
      : ({
          id: RUN_ID,
          projectId: PROJECT_ID,
          nodeId: NODE_ID,
          adapterId: 'claude',
          status: 'running',
          cwd: projectPath,
          branch: 'forgeboard/agent-one/claude-1',
          worktreeId: '70000000-0000-4000-8000-000000000001',
          startedAt: null,
          endedAt: null,
          exitCode: null,
          createdAt: '2026-07-25T12:00:00.000Z',
          updatedAt: '2026-07-25T12:00:00.000Z',
          ...options.runRecord,
        } as StoredRunRecord);
  const store = {
    getProject: (id: string) => (id === PROJECT_ID ? project : undefined),
    getRun: (id: string) => (id === RUN_ID ? record : undefined),
  };
  const service = new AgentSessionPrService(store, exec, (name) =>
    Promise.resolve(`/usr/local/bin/${name}`),
  );
  return { service, commands };
}

describe('AgentSessionPrService', () => {
  it('commits, pushes, and creates the PR with argv arrays for a dirty worktree run', async () => {
    const { service, commands } = harness({ statusOutput: ' M src/app.ts\n' });

    const view = await service.create({ projectId: PROJECT_ID, nodeId: NODE_ID, runId: RUN_ID });

    expect(commands.map((command) => [path.basename(command.file), ...command.args])).toEqual([
      ['git', 'status', '--porcelain'],
      ['git', 'add', '--all'],
      ['git', 'commit', '--message', AGENT_PR_COMMIT_MESSAGE],
      ['git', 'push', '--set-upstream', 'origin', 'forgeboard/agent-one/claude-1'],
      ['gh', 'pr', 'create', '--fill', '--head', 'forgeboard/agent-one/claude-1'],
    ]);
    expect(view).toEqual({
      url: 'https://github.com/acme/app/pull/42',
      branch: 'forgeboard/agent-one/claude-1',
      committed: true,
    });
  });

  it('skips the commit when the tree is clean', async () => {
    const { service, commands } = harness({ statusOutput: '' });

    const view = await service.create({ projectId: PROJECT_ID, nodeId: NODE_ID, runId: RUN_ID });

    expect(commands.map((command) => command.args[0])).toEqual(['status', 'push', 'pr']);
    expect(view.committed).toBe(false);
  });

  it('uses the checked-out branch in the project directory when no run is given', async () => {
    const { service, commands } = harness({ statusOutput: '' });

    const view = await service.create({ projectId: PROJECT_ID, nodeId: NODE_ID });

    expect(commands[0]?.args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(view.branch).toBe('feature/current');
    expect(commands.every((command) => command.cwd === process.cwd())).toBe(true);
  });

  it('rejects a run that no longer matches the node', async () => {
    const { service } = harness({ runRecord: { nodeId: 'someone-else' } });

    await expect(
      service.create({ projectId: PROJECT_ID, nodeId: NODE_ID, runId: RUN_ID }),
    ).rejects.toThrow(/no longer matches/u);
  });

  it('fails tersely when the session folder is gone', async () => {
    const missing = path.join(
      await realpath(await mkdtemp(path.join(os.tmpdir(), 'forgeboard-agent-pr-'))),
      'deleted',
    );
    const { service } = harness({ projectPath: missing, runRecord: null });

    await expect(service.create({ projectId: PROJECT_ID, nodeId: NODE_ID })).rejects.toThrow(
      /session folder is gone/u,
    );
  });

  it('surfaces the failing command with its stderr tail', async () => {
    const { service } = harness({
      statusOutput: '',
      failCommand: { argsPrefix: 'push', stderr: 'fatal: could not read from remote repository' },
    });

    await expect(
      service.create({ projectId: PROJECT_ID, nodeId: NODE_ID, runId: RUN_ID }),
    ).rejects.toThrow(/git push: fatal: could not read from remote repository/u);
  });
});

describe('pullRequestUrl', () => {
  it('extracts the PR URL from gh output', () => {
    expect(pullRequestUrl('done\nhttps://github.com/acme/app/pull/7\n')).toBe(
      'https://github.com/acme/app/pull/7',
    );
  });

  it('returns null when gh printed no PR URL', () => {
    expect(pullRequestUrl('a pull request for branch x already exists')).toBeNull();
    expect(pullRequestUrl('https://github.com/acme/app/issues/7')).toBeNull();
  });
});
