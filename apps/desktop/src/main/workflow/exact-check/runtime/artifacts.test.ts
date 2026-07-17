import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExactCheckRequest } from '../contracts.js';
import { verifyConfiguredArtifacts } from './artifacts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('verifyConfiguredArtifacts', () => {
  it('publishes only configured, regular, non-sensitive files with exact identity and hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-test-artifacts-'));
    roots.push(root);
    await write(root, 'coverage/index.html', '<h1>coverage</h1>');
    await write(root, '.env.production', 'TOKEN=secret');
    await write(root, 'outside.json', '{}');
    await mkdir(join(root, 'reports'), { recursive: true });
    await symlink(join(root, 'outside.json'), join(root, 'reports', 'linked.json'));

    const artifacts = await verifyConfiguredArtifacts(
      root,
      request([
        'coverage/index.html',
        '.env.production',
        'reports/linked.json',
        'reports/missing.json',
      ]),
    );

    expect(artifacts).toEqual([
      expect.objectContaining({
        executionId: 'workflow-execution',
        nodeId: 'test-node',
        attempt: 2,
        relativePath: 'coverage/index.html',
        kind: 'report',
        sizeBytes: 17,
      }),
    ]);
    expect(artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('returns no artifact references when the checkout disappears during finalization', async () => {
    const missing = join(tmpdir(), `forgeboard-missing-artifacts-${String(Date.now())}`);
    await expect(
      verifyConfiguredArtifacts(missing, request(['coverage/index.html'])),
    ).resolves.toEqual([]);
  });
});

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function request(artifactPaths: string[]): ExactCheckRequest {
  return {
    checkId: 'test',
    kind: 'test',
    label: 'Tests',
    command: { executable: 'node', args: [], environmentNames: [] },
    target: {
      kind: 'primary-project',
      projectId: '10000000-0000-4000-8000-000000000001',
    },
    workflowBinding: { executionId: 'workflow-execution', nodeId: 'test-node', attempt: 2 },
    artifactPaths,
  };
}
