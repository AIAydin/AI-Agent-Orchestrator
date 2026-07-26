import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('GitHub workflows take the pnpm version from packageManager only', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.match(manifest.packageManager ?? '', /^pnpm@\d+\.\d+\.\d+$/u);

  for (const workflow of ['ci.yml', 'release.yml']) {
    const source = await readFile(
      path.join(repositoryRoot, '.github', 'workflows', workflow),
      'utf8',
    );
    assert.match(source, /uses:\s+pnpm\/action-setup@/u);
    assert.doesNotMatch(
      source,
      /-\s+uses:\s+pnpm\/action-setup@[^\n]*\n\s+with:\n\s+version:/u,
      `${workflow} must not override package.json packageManager`,
    );
  }
});

test('the collaboration image copies local core sources before bundling the server', async () => {
  const source = await readFile(
    path.join(repositoryRoot, 'apps', 'collab-server', 'Dockerfile'),
    'utf8',
  );
  const workspaceCopy = source.indexOf('COPY package.json pnpm-lock.yaml pnpm-workspace.yaml');
  const patchesCopy = source.indexOf('COPY patches ./patches');
  const install = source.indexOf('pnpm install --frozen-lockfile');
  const manifestCopy = source.indexOf('COPY packages/core/package.json');
  const sourceCopy = source.indexOf('COPY packages/core/src');
  const serverBuild = source.indexOf('RUN pnpm --filter @forgeboard/collab-server build');

  assert.ok(workspaceCopy >= 0, 'Dockerfile must copy the pnpm workspace inputs');
  assert.ok(
    patchesCopy > workspaceCopy,
    'Dockerfile must copy managed patches after workspace inputs',
  );
  assert.ok(install > patchesCopy, 'Dockerfile must copy managed patches before install');
  assert.ok(manifestCopy >= 0, 'Dockerfile must copy the core package manifest before install');
  assert.ok(sourceCopy > manifestCopy, 'Dockerfile must copy the core package source');
  assert.ok(
    serverBuild > sourceCopy,
    'Dockerfile must copy core source before building the server',
  );
});
