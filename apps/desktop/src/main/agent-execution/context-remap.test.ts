import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentExecutionContextRequest } from './contracts.js';
import { remapContextIntoWorktree } from './runtime.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('agent worktree context remapping', () => {
  it('remaps an approved project file only when worktree bytes match', async () => {
    const { project, worktree } = await roots();
    await mkdir(path.join(project, 'src'));
    await mkdir(path.join(worktree, 'src'));
    await writeFile(path.join(project, 'src', 'task.ts'), 'same\n');
    await writeFile(path.join(worktree, 'src', 'task.ts'), 'same\n');

    const remapped = await remapContextIntoWorktree(
      context(path.join(project, 'src', 'task.ts')),
      project,
      worktree,
    );

    expect(remapped.attachments[0]?.path).toBe(path.join(worktree, 'src', 'task.ts'));
    expect(remapped.manifestDigest).toBe('a'.repeat(64));

    await expect(
      remapContextIntoWorktree(
        {
          ...context(path.join(project, 'src', 'task.ts')),
          attachments: [
            {
              path: path.join(project, 'src', 'task.ts'),
              kind: 'file',
              explicitlyApproved: true,
              sha256: 'f'.repeat(64),
            },
          ],
        },
        project,
        worktree,
      ),
    ).rejects.toThrow(/approved digest/iu);

    await writeFile(path.join(worktree, 'src', 'task.ts'), 'different\n');
    await expect(
      remapContextIntoWorktree(context(path.join(project, 'src', 'task.ts')), project, worktree),
    ).rejects.toThrow(/approved digest/iu);
  });

  it('rejects a symlinked worktree target instead of escaping the assigned checkout', async () => {
    const { project, worktree, root } = await roots();
    const outside = path.join(root, 'outside.ts');
    await writeFile(path.join(project, 'task.ts'), 'same\n');
    await writeFile(outside, 'same\n');
    await symlink(outside, path.join(worktree, 'task.ts'));

    await expect(
      remapContextIntoWorktree(context(path.join(project, 'task.ts')), project, worktree),
    ).rejects.toThrow(/ordinary file|symbolic-link/iu);
  });

  it('remaps generated logical paths without requiring source or worktree files', async () => {
    const { project, worktree } = await roots();
    const sourcePath = path.join(project, '.forgeboard-context', 'brief.md');
    const content = '# Brief\n';
    const digest = createHash('sha256').update(content).digest('hex');
    const remapped = await remapContextIntoWorktree(
      {
        attachments: [
          {
            path: sourcePath,
            kind: 'file',
            explicitlyApproved: true,
            sha256: digest,
          },
        ],
        generatedArtifacts: [{ path: sourcePath, content, sha256: digest }],
        manifestId: 'generated-context',
        manifestDigest: 'b'.repeat(64),
      },
      project,
      worktree,
    );

    const expected = path.join(worktree, '.forgeboard-context', 'brief.md');
    expect(remapped.attachments[0]?.path).toBe(expected);
    expect(remapped.generatedArtifacts?.[0]?.path).toBe(expected);
  });
});

function context(filePath: string): AgentExecutionContextRequest {
  return {
    attachments: [
      {
        path: filePath,
        kind: 'file',
        explicitlyApproved: true,
        sha256: createHash('sha256').update('same\n').digest('hex'),
      },
    ],
    manifestId: 'context-v1',
    manifestDigest: 'a'.repeat(64),
  };
}

async function roots(): Promise<{ root: string; project: string; worktree: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forgeboard-context-remap-')));
  temporaryDirectories.push(root);
  const project = path.join(root, 'project');
  const worktree = path.join(root, 'worktree');
  await mkdir(project);
  await mkdir(worktree);
  return { root, project, worktree };
}
