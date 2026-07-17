import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import { isSensitivePath } from '@forgeboard/core';

import type { WorkflowArtifactActionInput } from '../../../../shared/workflow/contracts.js';
import { WorkflowArtifactActionInputSchema } from '../../../../shared/workflow/contracts.js';
import { canonicalProjectRoot } from '../../../checks/check-process.js';
import type { GitTargetResolver } from '../../../git/git-target-resolver.js';
import type { LocalStore } from '../../../storage.js';

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export class WorkflowArtifactActionResolver {
  public constructor(
    private readonly store: Pick<LocalStore, 'getProject' | 'getCheckExecution'>,
    private readonly gitTargets: GitTargetResolver,
    private readonly stagingRoot: string,
  ) {}

  public async resolve(
    untrustedInput: WorkflowArtifactActionInput,
    action: 'reveal' | 'open' = 'reveal',
  ): Promise<string> {
    const input = WorkflowArtifactActionInputSchema.parse(untrustedInput);
    const execution = this.store.getCheckExecution(input.checkExecutionId);
    if (
      execution === undefined ||
      execution.workflowBinding?.executionId !== input.executionId ||
      execution.workflowBinding.nodeId !== input.nodeId ||
      execution.workflowBinding.attempt !== input.attempt
    ) {
      throw new Error('The Test artifact is not bound to this workflow attempt.');
    }
    const artifact = (execution.artifacts ?? []).find(
      (candidate) =>
        candidate.relativePath === input.relativePath && candidate.sha256 === input.sha256,
    );
    if (artifact === undefined || execution.target === undefined) {
      throw new Error('The Test artifact is no longer part of the recorded execution.');
    }
    if (isSensitivePath(artifact.relativePath)) {
      throw new Error('Sensitive files cannot be opened as Test artifacts.');
    }
    const root = await this.#targetRoot(execution.target);
    return await revalidateArtifact(
      root,
      artifact.relativePath,
      artifact.sha256,
      artifact.sizeBytes,
      action === 'open' ? this.stagingRoot : undefined,
    );
  }

  async #targetRoot(target: NonNullable<ReturnType<LocalStore['getCheckExecution']>>['target']) {
    if (target === undefined) throw new Error('The Test artifact target is unavailable.');
    if (target.kind === 'primary-project') {
      const project = this.store.getProject(target.projectId);
      if (project === undefined || project.missing) {
        throw new Error('The Test artifact project is no longer available.');
      }
      return (await canonicalProjectRoot(project.path)).path;
    }
    const resolved = await this.gitTargets.resolve({
      projectId: target.projectId,
      runId: target.runId,
    });
    return (await canonicalProjectRoot(resolved.worktreeRepositoryPath)).path;
  }
}

async function revalidateArtifact(
  root: string,
  relativePath: string,
  expectedSha256: string,
  expectedSize: number,
  stagingRoot: string | undefined,
): Promise<string> {
  await rejectSymlinkSegments(root, relativePath);
  const candidate = path.resolve(root, ...relativePath.split('/'));
  assertContained(root, candidate);
  const canonical = await realpath(candidate);
  assertContained(root, canonical);
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const file = await open(canonical, flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expectedSize || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error('The Test artifact changed after the recorded execution.');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const read = await file.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    if (position !== stat.size || hash.digest('hex') !== expectedSha256) {
      throw new Error('The Test artifact changed after the recorded execution.');
    }
    if (stagingRoot !== undefined) {
      return await stageVerifiedArtifact(
        file,
        relativePath,
        expectedSha256,
        expectedSize,
        stagingRoot,
      );
    }
  } finally {
    await file.close();
  }
  return canonical;
}

async function stageVerifiedArtifact(
  source: Awaited<ReturnType<typeof open>>,
  relativePath: string,
  expectedSha256: string,
  expectedSize: number,
  stagingRoot: string,
): Promise<string> {
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const extension = path
    .extname(relativePath)
    .slice(0, 20)
    .replaceAll(/[^A-Za-z0-9._-]/gu, '');
  const stagedPath = path.join(stagingRoot, `${expectedSha256}-${randomUUID()}${extension}`);
  const target = await open(
    stagedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let complete = false;
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expectedSize) {
      const read = await source.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - position),
        position,
      );
      if (read.bytesRead === 0) break;
      let written = 0;
      while (written < read.bytesRead) {
        const result = await target.write(
          buffer,
          written,
          read.bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    if (position !== expectedSize || hash.digest('hex') !== expectedSha256) {
      throw new Error('The Test artifact changed while preparing the external copy.');
    }
    await target.sync();
    complete = true;
    return stagedPath;
  } finally {
    await target.close();
    if (!complete) await unlink(stagedPath).catch(() => undefined);
  }
}

async function rejectSymlinkSegments(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('Artifact paths cannot use links.');
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The Test artifact resolves outside its recorded checkout.');
  }
}
