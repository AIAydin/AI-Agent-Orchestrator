import { createHash } from 'node:crypto';

import { GitEngineError } from '../model/errors.js';
import type { DiffFile, DiffFileStatus, DiffHunk, DiffLine, ParsedDiff } from '../model/types.js';

function decodeQuotedGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? '';
    if (character !== '\\') {
      bytes.push(...Buffer.from(character));
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) break;
    const simple: Readonly<Record<string, number>> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      '\\': 92,
    };
    if (simple[escaped] !== undefined) {
      bytes.push(simple[escaped]);
      index += 1;
      continue;
    }
    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{1,3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    bytes.push(...Buffer.from(escaped));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function pathFromMarker(line: string): string | null {
  const marker = line.slice(4).replace(/\t.*$/u, '');
  if (marker === '/dev/null') return null;
  const decoded = decodeQuotedGitPath(marker);
  return decoded.startsWith('a/') || decoded.startsWith('b/') ? decoded.slice(2) : decoded;
}

function statusFromHeader(header: string, binary: boolean): DiffFileStatus {
  if (binary) return 'binary';
  if (/^new file mode /mu.test(header)) return 'added';
  if (/^deleted file mode /mu.test(header)) return 'deleted';
  if (/^rename from /mu.test(header)) return 'renamed';
  if (/^copy from /mu.test(header)) return 'copied';
  return 'modified';
}

function buildHunk(
  fileIdentity: readonly [string | null, string | null],
  header: string,
  body: readonly string[],
): DiffHunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (match === null)
    throw new GitEngineError('INVALID_PATCH', 'Malformed unified diff hunk.', { header });
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  let oldLine = oldStart;
  let newLine = newStart;
  const lines: DiffLine[] = [];

  for (const rawLine of body) {
    const prefix = rawLine[0] ?? '';
    if (prefix === '+') {
      lines.push({ kind: 'addition', content: rawLine.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (prefix === '-') {
      lines.push({ kind: 'deletion', content: rawLine.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (prefix === ' ') {
      lines.push({ kind: 'context', content: rawLine.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      lines.push({ kind: 'metadata', content: rawLine, oldLine: null, newLine: null });
    }
  }

  const patch = `${header}\n${body.map((line) => `${line}\n`).join('')}`;
  const id = createHash('sha256')
    .update(JSON.stringify(fileIdentity))
    .update('\0')
    .update(patch)
    .digest('hex')
    .slice(0, 20);
  return { id, header, oldStart, oldLines, newStart, newLines, lines, patch };
}

/** Parses a standard `git diff --no-color --unified=N` patch. */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  if (raw === '') return { raw, files: [], additions: 0, deletions: 0 };
  const allLines = raw.split('\n');
  if (allLines.at(-1) === '') allLines.pop();
  const files: DiffFile[] = [];
  let additions = 0;
  let deletions = 0;
  let index = 0;

  while (index < allLines.length) {
    if (!(allLines[index] ?? '').startsWith('diff --git ')) {
      index += 1;
      continue;
    }
    const headerLines: string[] = [];
    while (index < allLines.length) {
      const line = allLines[index] ?? '';
      if (headerLines.length > 0 && (line.startsWith('diff --git ') || line.startsWith('@@ ')))
        break;
      headerLines.push(line);
      index += 1;
    }

    const oldMarker = headerLines.find((line) => line.startsWith('--- '));
    const newMarker = headerLines.find((line) => line.startsWith('+++ '));
    const oldPath = oldMarker === undefined ? null : pathFromMarker(oldMarker);
    const newPath = newMarker === undefined ? null : pathFromMarker(newMarker);
    const binary = headerLines.some(
      (line) => line.startsWith('Binary files ') || line === 'GIT binary patch',
    );
    const hunks: DiffHunk[] = [];

    while (index < allLines.length && (allLines[index] ?? '').startsWith('@@ ')) {
      const hunkHeader = allLines[index] ?? '';
      index += 1;
      const body: string[] = [];
      while (index < allLines.length) {
        const line = allLines[index] ?? '';
        if (line.startsWith('@@ ') || line.startsWith('diff --git ')) break;
        body.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
        if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
        index += 1;
      }
      hunks.push(buildHunk([oldPath, newPath], hunkHeader, body));
    }

    const header = `${headerLines.map((line) => `${line}\n`).join('')}`;
    files.push({
      oldPath,
      newPath,
      status: statusFromHeader(header, binary),
      binary,
      header,
      hunks,
    });
  }

  return { raw, files, additions, deletions };
}

export function selectDiffHunks(diff: ParsedDiff, hunkIds: readonly string[]): string {
  const requested = new Set(hunkIds);
  if (requested.size !== hunkIds.length) {
    throw new GitEngineError('INVALID_PATCH', 'Duplicate hunk identifiers were requested.');
  }
  const selected: string[] = [];
  for (const file of diff.files) {
    const hunks = file.hunks.filter((hunk) => requested.delete(hunk.id));
    if (hunks.length === 0) continue;
    if (file.binary) {
      throw new GitEngineError('INVALID_PATCH', 'Binary patches cannot be selected by hunk.');
    }
    selected.push(file.header, ...hunks.map((hunk) => hunk.patch));
  }
  if (requested.size > 0) {
    throw new GitEngineError('INVALID_PATCH', 'One or more requested hunks do not exist.', {
      missingHunkIds: [...requested],
    });
  }
  if (selected.length === 0) {
    throw new GitEngineError('INVALID_PATCH', 'At least one hunk must be selected.');
  }
  return selected.join('');
}

export function patchSha256(patch: string): string {
  return createHash('sha256').update(patch).digest('hex');
}
