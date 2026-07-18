import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

import type { RepositoryService } from '@forgeboard/git-engine';
import { z } from 'zod';

const ReviewedArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRunId: z.string().uuid(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            status: z.literal('present'),
            content: z.string().max(400_000),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();

export interface ReviewedGitIdentityInput {
  readonly sourceRunId: string;
  readonly artifactWorktreePath: string;
  readonly artifactContent: string;
  readonly artifactDigest: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly sourceHead: string;
  readonly expectedSourceTree: string;
}

/** Proves that the complete committed delta is byte-for-byte the bounded output that was reviewed. */
export async function assertReviewedGitIdentity(
  repositories: RepositoryService,
  input: ReviewedGitIdentityInput,
): Promise<void> {
  if (
    createHash('sha256').update(input.artifactContent, 'utf8').digest('hex') !==
    input.artifactDigest
  ) {
    throw new Error('The private reviewed output artifact digest is invalid.');
  }
  const artifact = ReviewedArtifactSchema.parse(JSON.parse(input.artifactContent));
  if (artifact.sourceRunId !== input.sourceRunId) {
    throw new Error('The reviewed output artifact belongs to another managed agent run.');
  }
  const [artifactRoot, worktreeRoot] = await Promise.all([
    realpath(path.resolve(input.artifactWorktreePath)),
    realpath(path.resolve(input.worktreePath)),
  ]);
  if (artifactRoot !== worktreeRoot) {
    throw new Error('The reviewed output artifact belongs to another managed worktree.');
  }
  const tree = await repositories.git.run([
    '-C',
    worktreeRoot,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${input.sourceHead}^{tree}`,
  ]);
  if (tree.stdout.trim() !== input.expectedSourceTree) {
    throw new Error('The reviewed Git source tree changed during identity verification.');
  }

  const reviewedFiles = new Map<string, string>();
  for (const file of artifact.files) {
    assertSafeRelativePath(file.path);
    if (reviewedFiles.has(file.path)) {
      throw new Error('The reviewed output artifact contains duplicate paths.');
    }
    reviewedFiles.set(file.path, file.content);
  }

  const changed = await changedPaths(
    repositories,
    worktreeRoot,
    input.baseCommit,
    input.sourceHead,
  );
  if (
    changed.length !== reviewedFiles.size ||
    changed.some((file) => !reviewedFiles.has(file.relativePath))
  ) {
    throw new Error('The current Git delta does not contain exactly the reviewed output paths.');
  }
  for (const file of changed) {
    const bytes = await committedBlob(repositories, worktreeRoot, file.blobOid);
    const content = bytes.toString('utf8');
    if (content.includes('\0') || !Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error('The current Git delta contains binary reviewed output.');
    }
    if (content !== reviewedFiles.get(file.relativePath)) {
      throw new Error('The current Git delta bytes do not match the reviewed output.');
    }
  }
}

interface ChangedFile {
  readonly relativePath: string;
  readonly blobOid: string;
}

async function changedPaths(
  repositories: RepositoryService,
  root: string,
  baseCommit: string,
  sourceHead: string,
): Promise<ChangedFile[]> {
  const raw = await repositories.git.runGuarded(
    [
      '-C',
      root,
      'diff',
      '--raw',
      '-z',
      '--abbrev=64',
      '--no-renames',
      baseCommit,
      sourceHead,
      '--',
    ],
    { repositoryPath: root, operation: 'object-inspection' },
  );
  const fields = nulFields(raw.stdout);
  if (fields.length % 2 !== 0) throw new Error('Git returned malformed raw diff output.');
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = /^:(\d{6}) (\d{6}) [a-f0-9]+ ([a-f0-9]+) ([A-Z])$/u.exec(fields[index]!);
    const relativePath = fields[index + 1]!;
    if (metadata === null || !['A', 'M'].includes(metadata[4]!)) {
      throw new Error(
        'Deleted, renamed, copied, conflicted, or type-changed output cannot be delivered.',
      );
    }
    const oldMode = metadata[1]!;
    const newMode = metadata[2]!;
    if (
      !['100644', '100755'].includes(newMode) ||
      (metadata[4] === 'A' ? oldMode !== '000000' || newMode !== '100644' : oldMode !== newMode)
    ) {
      throw new Error('Mode-changed, symlink, submodule, or non-file output cannot be delivered.');
    }
    files.push({ relativePath, blobOid: metadata[3]! });
  }
  for (const file of files) assertSafeRelativePath(file.relativePath);
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) {
    throw new Error('Git returned duplicate reviewed output paths.');
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function committedBlob(
  repositories: RepositoryService,
  root: string,
  blobOid: string,
): Promise<Buffer> {
  const blob = await repositories.git.runBinary(['-C', root, 'cat-file', 'blob', blobOid]);
  return Buffer.from(blob.stdout);
}

function nulFields(value: string): string[] {
  if (value === '') return [];
  if (!value.endsWith('\0')) throw new Error('Git returned malformed NUL-delimited output.');
  return value.slice(0, -1).split('\0');
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error('The reviewed output artifact contains an unsafe path.');
  }
}
