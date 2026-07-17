import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isSensitivePath } from '@forgeboard/core';

import {
  CheckArtifactReferenceSchema,
  type CheckExecutionView,
} from '../../../../shared/checks/contracts.js';
import type { ExactCheckRequest } from '../contracts.js';

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export async function verifyConfiguredArtifacts(
  repositoryRoot: string,
  request: ExactCheckRequest,
): Promise<NonNullable<CheckExecutionView['artifacts']>> {
  if (request.workflowBinding === undefined) return [];
  let root: string;
  try {
    root = await realpath(repositoryRoot);
  } catch {
    return [];
  }
  const artifacts: NonNullable<CheckExecutionView['artifacts']>[number][] = [];
  for (const relativePath of request.artifactPaths ?? []) {
    if (isSensitivePath(relativePath)) continue;
    const candidate = path.resolve(root, ...relativePath.split('/'));
    if (!contained(root, candidate)) continue;
    try {
      await rejectSymlinkSegments(root, relativePath);
      const canonical = await realpath(candidate);
      if (!contained(root, canonical)) continue;
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
      const file = await open(canonical, flags);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) continue;
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
        if (position !== stat.size) continue;
        artifacts.push(
          CheckArtifactReferenceSchema.parse({
            ...request.workflowBinding,
            projectId: request.target.projectId,
            relativePath,
            label: path.posix.basename(relativePath),
            kind: reportKind(relativePath),
            sha256: hash.digest('hex'),
            sizeBytes: stat.size,
          }),
        );
      } finally {
        await file.close();
      }
    } catch {
      // Only successfully revalidated, no-follow regular files become trusted references.
    }
  }
  return artifacts;
}

async function rejectSymlinkSegments(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('Artifact paths cannot use links.');
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function reportKind(relativePath: string): 'artifact' | 'report' {
  return /(?:^|\/)(?:coverage|reports?)(?:\/|$)|\.(?:html?|json|xml|lcov)$/iu.test(relativePath)
    ? 'report'
    : 'artifact';
}
