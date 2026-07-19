import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJsonPath = path.join(repositoryRoot, 'package.json');
const canonicalUserCommands = [
  'start',
  'verify',
  'test:e2e',
  'dev:collab',
  'package',
  'smoke:packaged',
  'smoke:installer',
];

test('local Markdown links resolve to files in the current repository', async () => {
  const files = await markdownFiles();
  const missing = [];

  for (const file of files) {
    const source = withoutFencedCode(await readFile(file, 'utf8'));
    for (const target of markdownLinkTargets(source)) {
      const localPath = localLinkPath(file, target);
      if (localPath === null) continue;
      try {
        await access(localPath);
      } catch {
        missing.push(`${path.relative(repositoryRoot, file)} -> ${target}`);
      }
    }
  }

  assert.deepEqual(missing, [], `Broken local Markdown links:\n${missing.join('\n')}`);
});

test('documented pnpm commands name current root scripts', async () => {
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const scripts = new Set(Object.keys(manifest.scripts ?? {}));
  const invalid = [];

  for (const file of await markdownFiles()) {
    const source = await readFile(file, 'utf8');
    for (const command of documentedPnpmCommands(source)) {
      if (command === 'install' || scripts.has(command)) continue;
      invalid.push(`${path.relative(repositoryRoot, file)} -> pnpm ${command}`);
    }
  }

  assert.deepEqual(invalid, [], `Documented commands without root scripts:\n${invalid.join('\n')}`);
});

test('README publishes the canonical UI-first and verification command set', async () => {
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');

  for (const command of canonicalUserCommands) {
    assert.equal(
      typeof manifest.scripts?.[command],
      'string',
      `package.json is missing the documented ${command} script`,
    );
    assert.match(
      readme,
      new RegExp(`corepack pnpm ${escapeRegExp(command)}(?:\\s|$)`, 'u'),
      `README.md is missing corepack pnpm ${command}`,
    );
  }
});

async function markdownFiles() {
  const files = [path.join(repositoryRoot, 'README.md')];
  for (const directory of ['docs', '.github']) {
    files.push(...(await markdownFilesBelow(path.join(repositoryRoot, directory))));
  }
  return files.sort();
}

async function markdownFilesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFilesBelow(candidate)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(candidate);
  }
  return files;
}

function markdownLinkTargets(source) {
  return [...source.matchAll(/!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map(
    (match) => match[1],
  );
}

function localLinkPath(sourceFile, rawTarget) {
  const target = rawTarget.replace(/^<|>$/gu, '');
  if (
    target === '' ||
    target.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
    target.includes('<') ||
    target.includes('>')
  ) {
    return null;
  }
  const withoutFragment = target.split('#', 1)[0]?.split('?', 1)[0];
  if (!withoutFragment) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return path.resolve(path.dirname(sourceFile), withoutFragment);
  }
  return path.resolve(path.dirname(sourceFile), decoded);
}

function documentedPnpmCommands(source) {
  return [...source.matchAll(/(?:^|[\n`])\s*(?:corepack\s+)?pnpm\s+([a-z][a-z0-9:-]*)/gimu)].map(
    (match) => match[1],
  );
}

function withoutFencedCode(source) {
  return source.replace(/```[\s\S]*?```/gu, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
