import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { findSensitivePath, loadProjectIgnoreMatcher } from '@forgeboard/core';

import type { AgentExecutionContextRequest } from '../contracts.js';

export async function revalidateContextAttachments(
  context: AgentExecutionContextRequest,
  checkoutPath: string,
): Promise<void> {
  if (context.attachments.length === 0) return;
  const canonicalCheckout = await realpath(path.resolve(checkoutPath));
  const ignoreMatcher = await loadProjectIgnoreMatcher(canonicalCheckout);
  await Promise.all(
    context.attachments.map(async (attachment) => {
      if (attachment.kind !== 'file' || attachment.sha256 === undefined) {
        throw new Error('Approved context must contain only digest-bound ordinary files.');
      }
      const canonical = await canonicalRegularFile(attachment.path, canonicalCheckout, 'approved');
      const relativePath = path.relative(canonicalCheckout, canonical).split(path.sep).join('/');
      if (findSensitivePath(relativePath) !== undefined) {
        throw new Error(
          'An approved context file became sensitive after disclosure. Review what will run.',
        );
      }
      if (ignoreMatcher.evaluate(relativePath).ignored) {
        throw new Error(
          'An approved context file became ignored after disclosure. Review what will run.',
        );
      }
      const digest = await stableFileDigest(canonical);
      if (digest !== attachment.sha256) {
        throw new Error('An approved context file changed after disclosure. Review what will run.');
      }
    }),
  );
}

export async function canonicalRegularFile(
  candidate: string,
  canonicalRoot: string,
  label: string,
): Promise<string> {
  const resolved = path.resolve(candidate);
  const details = await lstat(resolved).catch(() => undefined);
  if (details === undefined || !details.isFile() || details.isSymbolicLink()) {
    throw new Error(`The selected ${label} context path is not an ordinary file.`);
  }
  const canonical = await realpath(resolved);
  if (!pathsEqual(canonical, resolved)) {
    throw new Error(`The selected ${label} context path crosses a symbolic-link alias.`);
  }
  const relativePath = path.relative(canonicalRoot, canonical);
  if (!isContainedRelativePath(relativePath)) {
    throw new Error(`The selected ${label} context path escapes its approved checkout.`);
  }
  return canonical;
}

export async function stableFileDigest(filePath: string): Promise<string> {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error('Selected context is no longer a regular file.');
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
  const after = await stat(filePath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('Selected context changed while Forgeboard verified it. Review what will run.');
  }
  return digest;
}

export function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
