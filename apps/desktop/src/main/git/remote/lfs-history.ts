import type { RepositoryService } from '@forgeboard/git-engine';

const LFS_POINTER_MAX_BYTES = 1_024;
const LFS_POINTER_MIN_BYTES = 114;
const MAX_LFS_CANDIDATE_BLOBS = 100_000;
const LFS_BATCH_SIZE = 2_048;
const LFS_POINTER_VERSIONS = new Set([
  'http://git-media.io/v/2',
  'https://hawser.github.com/spec/v1',
  'https://git-lfs.github.com/spec/v1',
]);

interface LfsBlobCandidate {
  readonly oid: string;
  readonly size: number;
}

export async function assertCompleteSourceHistory(
  repositories: RepositoryService,
  repositoryPath: string,
  sourceHead: string,
): Promise<void> {
  const shallow = await repositories.git.run(
    ['-C', repositoryPath, 'rev-parse', '--is-shallow-repository'],
    { maxOutputBytes: 1_024, timeoutMs: 60_000 },
  );
  if (shallow.stdout.trim() !== 'false') {
    throw new Error('Shallow repositories are unsupported for exact remote delivery.');
  }
  await repositories.git.run(
    ['-C', repositoryPath, 'rev-list', '--objects', '--quiet', '--missing=error', sourceHead, '--'],
    { maxOutputBytes: 16 * 1_024, timeoutMs: 120_000 },
  );
}

export async function assertNoLfsPointerHistory(
  repositories: RepositoryService,
  repositoryPath: string,
  sourceHead: string,
): Promise<void> {
  const result = await repositories.git.run(
    [
      '-C',
      repositoryPath,
      'rev-list',
      '--objects',
      '--no-object-names',
      '--filter=object:type=blob',
      `--filter=blob:limit=${String(LFS_POINTER_MAX_BYTES)}`,
      '--filter-provided-objects',
      '--missing=error',
      sourceHead,
      '--',
    ],
    {
      maxOutputBytes: (MAX_LFS_CANDIDATE_BLOBS + 1) * 65,
      timeoutMs: 120_000,
    },
  );
  const objectIds = parseObjectIdLines(result.stdout);
  if (objectIds.length > MAX_LFS_CANDIDATE_BLOBS) {
    throw new Error(
      'This history has too many small objects to verify safely for exact remote delivery.',
    );
  }
  if (objectIds.length === 0) return;
  const uniqueObjectIds = [...new Set(objectIds)];
  const checked = await repositories.git.run(
    ['-C', repositoryPath, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      input: `${uniqueObjectIds.join('\n')}\n`,
      maxOutputBytes: uniqueObjectIds.length * 84 + 16 * 1_024,
      timeoutMs: 120_000,
    },
  );
  const candidates = parseLfsBatchCheck(checked.stdout, uniqueObjectIds);
  for (let index = 0; index < candidates.length; index += LFS_BATCH_SIZE) {
    const batch = candidates.slice(index, index + LFS_BATCH_SIZE);
    const objects = await repositories.git.runBinary(
      ['-C', repositoryPath, 'cat-file', '--batch'],
      {
        input: `${batch.map((candidate) => candidate.oid).join('\n')}\n`,
        maxOutputBytes:
          batch.reduce((total, candidate) => total + candidate.size + 96, 0) + 16 * 1_024,
        timeoutMs: 120_000,
      },
    );
    if (batchContainsGitLfsPointer(objects.stdout, batch)) {
      throw new Error(
        'Git LFS-backed history needs a separately disclosed LFS upload and is not supported by exact remote delivery yet.',
      );
    }
  }
}

function parseObjectIdLines(stdout: string): readonly string[] {
  if (stdout === '') return [];
  if (!stdout.endsWith('\n')) throw new Error('Forgeboard could not verify reachable Git objects.');
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.some((line) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(line))) {
    throw new Error('Forgeboard could not verify reachable Git objects.');
  }
  return lines;
}

function parseLfsBatchCheck(
  stdout: string,
  expectedObjectIds: readonly string[],
): readonly LfsBlobCandidate[] {
  if (!stdout.endsWith('\n')) throw new Error('Forgeboard could not verify Git object metadata.');
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.length !== expectedObjectIds.length) {
    throw new Error('Forgeboard could not verify Git object metadata.');
  }
  return lines.flatMap((line, index) => {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u.exec(line);
    const oid = match?.[1];
    const size = match === null ? Number.NaN : Number.parseInt(match[2] ?? '', 10);
    if (
      oid === undefined ||
      oid !== expectedObjectIds[index] ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size >= LFS_POINTER_MAX_BYTES
    ) {
      throw new Error('Forgeboard could not verify Git object metadata.');
    }
    return size >= LFS_POINTER_MIN_BYTES ? [{ oid, size }] : [];
  });
}

function batchContainsGitLfsPointer(
  stdout: Uint8Array,
  expected: readonly LfsBlobCandidate[],
): boolean {
  const framed = Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength);
  let offset = 0;
  for (const object of expected) {
    const headerEnd = framed.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('Forgeboard could not verify Git object contents.');
    const header = framed.subarray(offset, headerEnd).toString('ascii');
    if (header !== `${object.oid} blob ${String(object.size)}`) {
      throw new Error('Forgeboard could not verify Git object contents.');
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + object.size;
    if (contentEnd >= framed.length || framed[contentEnd] !== 0x0a) {
      throw new Error('Forgeboard could not verify Git object contents.');
    }
    if (isGitLfsPointer(framed.subarray(contentStart, contentEnd))) return true;
    offset = contentEnd + 1;
  }
  if (offset !== framed.length) {
    throw new Error('Forgeboard could not verify Git object contents.');
  }
  return false;
}

export function isGitLfsPointer(content: Uint8Array): boolean {
  if (content.byteLength < LFS_POINTER_MIN_BYTES || content.byteLength >= LFS_POINTER_MAX_BYTES) {
    return false;
  }
  const decoded = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
    .toString('utf8')
    .trim();
  const lines = decoded
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line !== '');
  let required: 'version' | 'oid' | 'size' | 'complete' = 'version';
  const extensions = new Map<string, string>();
  for (const line of lines) {
    if (required === 'complete') return false;
    const extension = /^(ext-([0-9])-(\S+)) sha256:[0-9a-f]{64}$/u.exec(line);
    if (extension !== null) {
      extensions.set(extension[1] ?? '', extension[2] ?? '');
      continue;
    }
    if (required === 'version') {
      if (!LFS_POINTER_VERSIONS.has(line.replace(/^version /u, ''))) return false;
      required = 'oid';
      continue;
    }
    if (required === 'oid') {
      if (!/^oid sha256:[0-9a-f]{64}$/u.test(line)) return false;
      required = 'size';
      continue;
    }
    const size = /^size (\+?[0-9]+)$/u.exec(line);
    if (size === null || !isNonnegativeInt64(size[1] ?? '')) return false;
    required = 'complete';
  }
  const priorities = [...extensions.values()];
  return required === 'complete' && new Set(priorities).size === priorities.length;
}

function isNonnegativeInt64(value: string): boolean {
  try {
    return BigInt(value) <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}
