import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectFileService, type FileDomainError, type FileProjectStore } from './index.js';
import { saveProjectDocument } from './writer.js';

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';

describe('ProjectFileService', () => {
  let fixtureRoot: string;
  let projectRoot: string;
  let outsideRoot: string;
  let store: FileProjectStore;

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'forgeboard-file-domain-')));
    projectRoot = path.join(fixtureRoot, 'project');
    outsideRoot = path.join(fixtureRoot, 'outside');
    await mkdir(projectRoot);
    await mkdir(outsideRoot);
    store = {
      getProject: (projectId) =>
        projectId === PROJECT_ID
          ? { id: PROJECT_ID, path: projectRoot, missing: false }
          : undefined,
    };
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('returns a bounded, ignore-aware tree without following symlinks', async () => {
    await writeFile(path.join(projectRoot, '.gitignore'), 'ignored.txt\nignored-dir/\n');
    await writeFile(path.join(projectRoot, '.env'), 'TOKEN=secret\n');
    await writeFile(path.join(projectRoot, 'ignored.txt'), 'ignored\n');
    await mkdir(path.join(projectRoot, 'ignored-dir'));
    await writeFile(path.join(projectRoot, 'ignored-dir', 'nested.txt'), 'nested\n');
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src', 'index.ts'), 'export {};\n');
    await writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n');
    await symlink(path.join(outsideRoot, 'secret.txt'), path.join(projectRoot, 'outside-link'));

    const service = new ProjectFileService(store, { maxDirectoryEntries: 100 });
    const tree = await service.tree({ projectId: PROJECT_ID, directory: '.' });

    expect(tree.truncated).toBe(false);
    expect(tree.entries.find((entry) => entry.name === '.env')).toMatchObject({
      policy: { status: 'sensitive' },
      canOpen: false,
    });
    expect(tree.entries.find((entry) => entry.name === 'ignored.txt')).toMatchObject({
      policy: { status: 'ignored' },
      canOpen: false,
    });
    expect(tree.entries.find((entry) => entry.name === 'outside-link')).toMatchObject({
      kind: 'symlink',
      policy: { status: 'symlink' },
      canOpen: false,
    });
    const ignoredListing = await service.tree({ projectId: PROJECT_ID, directory: 'ignored-dir' });
    expect(ignoredListing.entries.find((entry) => entry.name === 'nested.txt')).toMatchObject({
      policy: { status: 'ignored' },
      canOpen: false,
    });
    const bounded = await new ProjectFileService(store, {
      maxDirectoryEntries: 2,
    }).tree({ projectId: PROJECT_ID, directory: '.' });
    expect(bounded.entries).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
  });

  it('returns editable UTF-8 snapshots but never returns binary or oversized bytes', async () => {
    await writeFile(path.join(projectRoot, 'note.txt'), 'hello\n');
    await writeFile(path.join(projectRoot, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(projectRoot, 'large.txt'), 'x'.repeat(17));
    const service = new ProjectFileService(store, { maxTextBytes: 16 });

    const text = await service.read({ projectId: PROJECT_ID, relativePath: 'note.txt' });
    expect(text).toMatchObject({
      contentKind: 'text',
      content: 'hello\n',
      sha256: digest('hello\n'),
      readOnly: false,
    });
    expect(await service.read({ projectId: PROJECT_ID, relativePath: 'asset.bin' })).toMatchObject({
      contentKind: 'binary',
      content: null,
      readOnly: true,
    });
    expect(await service.read({ projectId: PROJECT_ID, relativePath: 'large.txt' })).toMatchObject({
      contentKind: 'too-large',
      content: null,
      sha256: null,
      readOnly: true,
    });
  });

  it('atomically saves text only when the optimistic content hash still matches', async () => {
    const target = path.join(projectRoot, 'note.txt');
    await writeFile(target, 'before\n');
    await chmod(target, 0o744);
    const service = new ProjectFileService(store);
    const opened = await service.read({ projectId: PROJECT_ID, relativePath: 'note.txt' });
    if (opened.sha256 === null) throw new Error('Expected a text hash.');

    const saved = await service.save({
      projectId: PROJECT_ID,
      relativePath: 'note.txt',
      expectedSha256: opened.sha256,
      content: 'after\n',
    });
    expect(saved).toMatchObject({ content: 'after\n', sha256: digest('after\n') });
    expect(await readFile(target, 'utf8')).toBe('after\n');
    expect((await readdir(projectRoot)).some((name) => name.startsWith('.forgeboard-save-'))).toBe(
      false,
    );

    await writeFile(target, 'external change\n');
    await expectCode(
      service.save({
        projectId: PROJECT_ID,
        relativePath: 'note.txt',
        expectedSha256: saved.sha256 ?? '',
        content: 'must not win\n',
      }),
      'STALE_CONTENT',
    );
    expect(await readFile(target, 'utf8')).toBe('external change\n');
  });

  it('serializes same-file saves so one stale writer cannot overwrite another', async () => {
    await writeFile(path.join(projectRoot, 'note.txt'), 'base\n');
    const service = new ProjectFileService(store);
    const opened = await service.read({ projectId: PROJECT_ID, relativePath: 'note.txt' });
    if (opened.sha256 === null) throw new Error('Expected a text hash.');

    const results = await Promise.allSettled([
      service.save({
        projectId: PROJECT_ID,
        relativePath: 'note.txt',
        expectedSha256: opened.sha256,
        content: 'first\n',
      }),
      service.save({
        projectId: PROJECT_ID,
        relativePath: 'note.txt',
        expectedSha256: opened.sha256,
        content: 'second\n',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'STALE_CONTENT' });
  });

  it('rejects a same-content target swap immediately before atomic rename', async () => {
    const target = path.join(projectRoot, 'note.txt');
    const displaced = path.join(projectRoot, 'note.displaced.txt');
    await writeFile(target, 'before\n');
    const service = new ProjectFileService(store);
    const opened = await service.read({ projectId: PROJECT_ID, relativePath: 'note.txt' });
    if (opened.sha256 === null) throw new Error('Expected a text hash.');

    await expectCode(
      saveProjectDocument(projectRoot, PROJECT_ID, 'note.txt', 'after\n', opened.sha256, {
        maxTextBytes: 1024,
        beforeFinalValidation: async () => {
          await rename(target, displaced);
          await writeFile(target, 'before\n');
        },
      }),
      'STALE_CONTENT',
    );
    expect(await readFile(target, 'utf8')).toBe('before\n');
    expect(await readFile(displaced, 'utf8')).toBe('before\n');
    expect((await readdir(projectRoot)).some((name) => name.startsWith('.forgeboard-save-'))).toBe(
      false,
    );
  });

  it('blocks absolute paths, traversal, sensitive content, and symlink escapes', async () => {
    await writeFile(path.join(projectRoot, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(projectRoot, 'ignored.txt'), 'ignored\n');
    await writeFile(path.join(projectRoot, '.env'), 'TOKEN=secret\n');
    await writeFile(path.join(projectRoot, 'inside.txt'), 'inside\n');
    await writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n');
    await symlink(path.join(outsideRoot, 'secret.txt'), path.join(projectRoot, 'outside-link'));
    await symlink(path.join(projectRoot, 'inside.txt'), path.join(projectRoot, 'inside-link'));
    const service = new ProjectFileService(store);

    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: path.join(outsideRoot, 'secret.txt') }),
      'INVALID_REQUEST',
    );
    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: '../outside/secret.txt' }),
      'INVALID_REQUEST',
    );
    // Ignored is not a refusal: the file opens with its real content.
    expect(
      await service.read({ projectId: PROJECT_ID, relativePath: 'ignored.txt' }),
    ).toMatchObject({ contentKind: 'text', content: 'ignored\n' });
    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: '.env' }),
      'SENSITIVE_FILE',
    );
    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: 'outside-link' }),
      'PATH_OUTSIDE_PROJECT',
    );
    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: 'inside-link' }),
      'PATH_NOT_CANONICAL',
    );
    await expectCode(
      service.save({
        projectId: PROJECT_ID,
        relativePath: path.join(outsideRoot, 'secret.txt'),
        expectedSha256: 'a'.repeat(64),
        content: 'must not write\n',
      }),
      'INVALID_REQUEST',
    );
    await expectCode(
      service.save({
        projectId: PROJECT_ID,
        relativePath: 'outside-link',
        expectedSha256: 'a'.repeat(64),
        content: 'must not write\n',
      }),
      'PATH_OUTSIDE_PROJECT',
    );
    await expectCode(
      service.save({
        projectId: PROJECT_ID,
        relativePath: '.env',
        expectedSha256: 'a'.repeat(64),
        content: 'must not write\n',
      }),
      'SENSITIVE_FILE',
    );
    expect(await readFile(path.join(outsideRoot, 'secret.txt'), 'utf8')).toBe('outside\n');

    const rejected = await service
      .read({ projectId: PROJECT_ID, relativePath: 'outside-link' })
      .catch((cause: unknown) => cause);
    expect(rejected).not.toHaveProperty('cause');
  });

  it('searches bounded approved UTF-8 content without exposing ignored, sensitive, or linked files', async () => {
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(projectRoot, 'src', 'first.ts'), 'const SearchNeedle = 1;\n');
    await writeFile(
      path.join(projectRoot, 'src', 'second.ts'),
      '// searchneedle twice searchneedle\n',
    );
    await writeFile(path.join(projectRoot, 'ignored.txt'), 'searchneedle ignored\n');
    await writeFile(path.join(projectRoot, '.env'), 'SEARCHNEEDLE=secret\n');
    await writeFile(path.join(projectRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(outsideRoot, 'outside.txt'), 'searchneedle outside\n');
    await symlink(path.join(outsideRoot, 'outside.txt'), path.join(projectRoot, 'outside-link'));
    const service = new ProjectFileService(store, { search: { maxResults: 2 } });

    const result = await service.search({ projectId: PROJECT_ID, query: 'SearchNeedle' });

    expect(result).toMatchObject({
      projectId: PROJECT_ID,
      query: 'SearchNeedle',
      truncated: true,
    });
    expect(result.skippedFiles).toBeGreaterThanOrEqual(1);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({
      relativePath: 'src/first.ts',
      line: 1,
      column: 7,
    });
    expect(result.matches.every((match) => match.relativePath.startsWith('src/'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('outside');
    expect(JSON.stringify(result)).not.toContain('ignored');
  });

  it('reverts by reloading disk and prepares reveal only for a canonical main-process target', async () => {
    const target = path.join(projectRoot, 'note.txt');
    await writeFile(target, 'one\n');
    await writeFile(path.join(projectRoot, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(projectRoot, 'ignored.txt'), 'ignored\n');
    await writeFile(path.join(projectRoot, '.env'), 'TOKEN=local-only\n');
    const service = new ProjectFileService(store);
    await service.read({ projectId: PROJECT_ID, relativePath: 'note.txt' });
    await writeFile(target, 'two\n');

    expect(await service.revert({ projectId: PROJECT_ID, relativePath: 'note.txt' })).toMatchObject(
      {
        content: 'two\n',
        sha256: digest('two\n'),
      },
    );
    expect(
      await service.prepareReveal({ projectId: PROJECT_ID, relativePath: 'note.txt' }),
    ).toEqual({
      projectId: PROJECT_ID,
      relativePath: 'note.txt',
      absolutePath: target,
      kind: 'file',
    });
    expect(
      await service.prepareOpenExternal({ projectId: PROJECT_ID, relativePath: 'note.txt' }),
    ).toEqual({
      projectId: PROJECT_ID,
      relativePath: 'note.txt',
      absolutePath: target,
      kind: 'file',
    });
    expect(await service.prepareReveal({ projectId: PROJECT_ID, relativePath: '.env' })).toEqual({
      projectId: PROJECT_ID,
      relativePath: '.env',
      absolutePath: path.join(projectRoot, '.env'),
      kind: 'file',
    });
    expect(
      await service.prepareReveal({ projectId: PROJECT_ID, relativePath: 'ignored.txt' }),
    ).toEqual({
      projectId: PROJECT_ID,
      relativePath: 'ignored.txt',
      absolutePath: path.join(projectRoot, 'ignored.txt'),
      kind: 'file',
    });
    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: '.env' }),
      'SENSITIVE_FILE',
    );
    await expectCode(
      service.prepareOpenExternal({ projectId: PROJECT_ID, relativePath: '.env' }),
      'SENSITIVE_FILE',
    );
    expect(
      await service.prepareOpenExternal({ projectId: PROJECT_ID, relativePath: 'ignored.txt' }),
    ).toEqual({
      projectId: PROJECT_ID,
      relativePath: 'ignored.txt',
      absolutePath: path.join(projectRoot, 'ignored.txt'),
      kind: 'file',
    });
  });

  it('opens, reverts, and saves git-ignored files exactly like tracked ones', async () => {
    await writeFile(
      path.join(projectRoot, '.gitignore'),
      '.gemini/\nnode_modules/\nbuild-output.txt\n',
    );
    await mkdir(path.join(projectRoot, '.gemini'));
    const nested = path.join(projectRoot, '.gemini', 'settings.json');
    await writeFile(nested, '{ "theme": "dark" }\n');
    await writeFile(path.join(projectRoot, 'build-output.txt'), 'generated\n');
    const service = new ProjectFileService(store);

    const opened = await service.read({
      projectId: PROJECT_ID,
      relativePath: '.gemini/settings.json',
    });
    expect(opened).toMatchObject({
      contentKind: 'text',
      content: '{ "theme": "dark" }\n',
      readOnly: false,
      readOnlyReason: null,
    });
    expect(
      await service.read({ projectId: PROJECT_ID, relativePath: 'build-output.txt' }),
    ).toMatchObject({ contentKind: 'text', content: 'generated\n' });

    if (opened.sha256 === null) throw new Error('Expected a text hash for an ignored file.');
    await expect(
      service.save({
        projectId: PROJECT_ID,
        relativePath: '.gemini/settings.json',
        expectedSha256: opened.sha256,
        content: '{ "theme": "light" }\n',
      }),
    ).resolves.toMatchObject({ content: '{ "theme": "light" }\n' });
    expect(await readFile(nested, 'utf8')).toBe('{ "theme": "light" }\n');
    expect(
      await service.revert({ projectId: PROJECT_ID, relativePath: '.gemini/settings.json' }),
    ).toMatchObject({ content: '{ "theme": "light" }\n' });
  });

  it('refuses sensitive content even when .gitignore also lists it', async () => {
    await writeFile(path.join(projectRoot, '.gitignore'), '.env\nsecrets/\n');
    await writeFile(path.join(projectRoot, '.env'), 'TOKEN=secret\n');
    await mkdir(path.join(projectRoot, 'secrets'));
    await writeFile(path.join(projectRoot, 'secrets', 'id_rsa'), 'PRIVATE KEY\n');
    const service = new ProjectFileService(store);

    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: '.env' }),
      'SENSITIVE_FILE',
    );
    await expectCode(
      service.read({ projectId: PROJECT_ID, relativePath: 'secrets/id_rsa' }),
      'SENSITIVE_FILE',
    );
    await expectCode(
      service.save({
        projectId: PROJECT_ID,
        relativePath: '.env',
        expectedSha256: 'a'.repeat(64),
        content: 'must not write\n',
      }),
      'SENSITIVE_FILE',
    );
    expect(await readFile(path.join(projectRoot, '.env'), 'utf8')).toBe('TOKEN=secret\n');
  });

  it('fails closed for missing projects and non-canonical project roots', async () => {
    const service = new ProjectFileService(store);
    await expectCode(
      service.read({
        projectId: 'c921ea40-e957-4f2b-98cc-166ee5f9830b',
        relativePath: 'note.txt',
      }),
      'PROJECT_NOT_FOUND',
    );

    const alias = path.join(fixtureRoot, 'project-alias');
    await symlink(projectRoot, alias, 'dir');
    const aliasService = new ProjectFileService({
      getProject: () => ({ id: PROJECT_ID, path: alias, missing: false }),
    });
    await expectCode(
      aliasService.tree({ projectId: PROJECT_ID, directory: '.' }),
      'PROJECT_ROOT_UNAVAILABLE',
    );
  });
});

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function expectCode(promise: Promise<unknown>, code: FileDomainError['code']): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
