import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckExecutionView } from '../../../../shared/checks/contracts.js';
import type { WorkflowArtifactActionInput } from '../../../../shared/workflow/contracts.js';
import type { GitTargetResolver } from '../../../git/git-target-resolver.js';
import { WorkflowArtifactActionResolver } from './artifact-actions.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const CHECK_ID = '20000000-0000-4000-8000-000000000001';
const EXECUTION_ID = 'workflow-execution';
const NODE_ID = 'test-node';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('WorkflowArtifactActionResolver', () => {
  it('re-resolves and hashes the exact recorded primary-checkout artifact', async () => {
    const fixture = await createFixture('coverage/index.html', '<h1>coverage</h1>');
    await expect(fixture.resolver.resolve(fixture.input)).resolves.toBe(
      await realpath(fixture.absolutePath),
    );
  });

  it('opens an app-owned verified copy that is unaffected by replacement of the source path', async () => {
    const fixture = await createFixture('coverage/index.html', '<h1>verified</h1>');
    const stagedPath = await fixture.resolver.resolve(fixture.input, 'open');
    await writeFile(fixture.absolutePath, '<h1>replaced</h1>');

    expect(stagedPath).not.toBe(await realpath(fixture.absolutePath));
    await expect(readFile(stagedPath, 'utf8')).resolves.toBe('<h1>verified</h1>');
  });

  it('rejects tampering, symlinks, sensitive paths, and mismatched attempt identity', async () => {
    const tampered = await createFixture('reports/result.json', '{"passed":true}');
    await writeFile(tampered.absolutePath, '{"passed":false}');
    await expect(tampered.resolver.resolve(tampered.input)).rejects.toThrow(/changed/u);

    const linked = await createFixture('reports/link.json', '{}', true);
    await expect(linked.resolver.resolve(linked.input)).rejects.toThrow(/links/u);

    const sensitive = await createFixture('.env.production', 'TOKEN=secret');
    await expect(sensitive.resolver.resolve(sensitive.input)).rejects.toThrow(/Sensitive/u);

    const identity = await createFixture('reports/identity.json', '{}');
    await expect(identity.resolver.resolve({ ...identity.input, attempt: 2 })).rejects.toThrow(
      /not bound/u,
    );
  });
});

async function createFixture(relativePath: string, content: string, link = false) {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-artifact-action-'));
  roots.push(root);
  const stagingRoot = join(root, '.forgeboard-verified-artifacts');
  const absolutePath = join(root, ...relativePath.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  if (link) {
    const target = join(root, 'real-artifact.json');
    await writeFile(target, content);
    await symlink(target, absolutePath);
  } else {
    await writeFile(absolutePath, content);
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  const input: WorkflowArtifactActionInput = {
    checkExecutionId: CHECK_ID,
    executionId: EXECUTION_ID,
    nodeId: NODE_ID,
    attempt: 1,
    relativePath,
    sha256,
  };
  const execution = checkExecution(relativePath, sha256, Buffer.byteLength(content));
  const resolver = new WorkflowArtifactActionResolver(
    {
      getProject: () => ({ path: root, missing: false }),
      getCheckExecution: (id: string) => (id === CHECK_ID ? execution : undefined),
    } as never,
    {} as GitTargetResolver,
    stagingRoot,
  );
  return { absolutePath, input, resolver };
}

function checkExecution(
  relativePath: string,
  sha256: string,
  sizeBytes: number,
): CheckExecutionView {
  return {
    id: CHECK_ID,
    projectId: PROJECT_ID,
    checkId: 'test',
    label: 'Tests',
    kind: 'test',
    executable: 'node',
    arguments: [],
    cwd: '.',
    environmentVariableNames: [],
    target: { kind: 'primary-project', projectId: PROJECT_ID },
    workflowBinding: { executionId: EXECUTION_ID, nodeId: NODE_ID, attempt: 1 },
    status: 'passed',
    exitCode: 0,
    startedAt: '2026-07-17T12:00:00.000Z',
    endedAt: '2026-07-17T12:00:01.000Z',
    output: '',
    outputTruncated: false,
    summary: null,
    artifacts: [
      {
        executionId: EXECUTION_ID,
        nodeId: NODE_ID,
        attempt: 1,
        projectId: PROJECT_ID,
        relativePath,
        label: relativePath.split('/').at(-1)!,
        kind: 'report',
        sha256,
        sizeBytes,
      },
    ],
    updatedAt: '2026-07-17T12:00:01.000Z',
  };
}
