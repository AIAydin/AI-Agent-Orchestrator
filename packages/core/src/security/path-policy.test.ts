import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IgnoreMatcher,
  SENSITIVE_OVERRIDE_ACKNOWLEDGEMENT,
  buildAttachmentManifest,
  findSensitivePath,
  isSensitivePath,
  resolveCanonicalPath,
} from './path-policy.js';

const NOW = '2026-07-14T12:00:00.000Z';
const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<{ base: string; root: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'forgeboard-core-'));
  temporaryDirectories.push(base);
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { base, root, outside };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('canonical path containment', () => {
  it('resolves an in-root file and returns its stable project-relative path', async () => {
    const { root } = await temporaryProject();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {}\n');
    await expect(
      resolveCanonicalPath(root, 'src/index.ts', { mustExist: true }),
    ).resolves.toMatchObject({
      relativePath: 'src/index.ts',
      exists: true,
    });
  });

  it('allows safe missing write targets by proving their nearest canonical ancestor', async () => {
    const { root } = await temporaryProject();
    await expect(resolveCanonicalPath(root, 'generated/deep/file.ts')).resolves.toMatchObject({
      relativePath: 'generated/deep/file.ts',
      exists: false,
    });
  });

  it('rejects lexical traversal before filesystem access', async () => {
    const { root } = await temporaryProject();
    await expect(resolveCanonicalPath(root, '../outside/secret.txt')).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });

  it('rejects a symlink whose canonical target escapes the approved root', async () => {
    const { root, outside } = await temporaryProject();
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'linked-outside'));
    await expect(
      resolveCanonicalPath(root, 'linked-outside/secret.txt', { mustExist: true }),
    ).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });

  it('requires explicit opt-in even for absolute paths that happen to be in root', async () => {
    const { root } = await temporaryProject();
    const filePath = path.join(root, 'file.txt');
    await writeFile(filePath, 'ok');
    await expect(resolveCanonicalPath(root, filePath)).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(
      resolveCanonicalPath(root, filePath, { allowAbsolute: true }),
    ).resolves.toMatchObject({ exists: true });
  });

  it('rejects cross-platform absolute and reserved device paths', async () => {
    const { root } = await temporaryProject();
    await expect(
      resolveCanonicalPath(root, 'C:\\Users\\someone\\secret.txt'),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(resolveCanonicalPath(root, 'NUL.txt')).rejects.toMatchObject({
      code: 'DEVICE_PATH',
    });
  });
});

describe('ignore and sensitive path policy', () => {
  it('applies git-style glob, directory, negation, and source ordering semantics', () => {
    const matcher = new IgnoreMatcher([
      { name: '.gitignore', content: 'dist/\n*.log\n!keep.log\ncache/**/generated.*\n' },
      { name: '.forgeboardignore', content: 'keep.log\n' },
    ]);
    expect(matcher.evaluate('dist/app.js')).toMatchObject({ ignored: true });
    expect(matcher.evaluate('debug.log')).toMatchObject({ ignored: true });
    expect(matcher.evaluate('keep.log')).toMatchObject({
      ignored: true,
      rule: { source: '.forgeboardignore' },
    });
    expect(matcher.evaluate('cache/a/b/generated.json')).toMatchObject({ ignored: true });
    expect(matcher.evaluate('src/app.ts')).toEqual({ ignored: false });
  });

  it('uses the last matching negation when no later policy overrides it', () => {
    const matcher = new IgnoreMatcher([{ name: '.gitignore', content: '*.log\n!important.log\n' }]);
    expect(matcher.evaluate('important.log')).toMatchObject({
      ignored: false,
      rule: { negated: true },
    });
  });

  it('recognizes dotenv, private-key, credential, auth-store, and certificate paths', () => {
    expect(isSensitivePath('.env.production')).toBe(true);
    expect(isSensitivePath('keys/id_ed25519')).toBe(true);
    expect(isSensitivePath('deploy/signing.p12')).toBe(true);
    expect(isSensitivePath('.aws/credentials')).toBe(true);
    expect(isSensitivePath('.git/config')).toBe(true);
    expect(isSensitivePath('certs/company.crt')).toBe(true);
    expect(findSensitivePath('src/index.ts')).toBeUndefined();
  });
});

describe('attachment manifests', () => {
  it('hashes and discloses the exact regular files and receiving provider', async () => {
    const { root } = await temporaryProject();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
    const manifest = await buildAttachmentManifest({
      manifestId: 'manifest-1',
      projectId: 'project-1',
      projectRoot: root,
      receivingAdapterId: 'codex',
      receivingProvider: 'OpenAI through local Codex CLI',
      relativePaths: ['src/index.ts'],
      createdAt: NOW,
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      receivingAdapterId: 'codex',
      receivingProvider: 'OpenAI through local Codex CLI',
      files: [{ relativePath: 'src/index.ts', policy: 'normal' }],
    });
    expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('denies ignored and sensitive files by default', async () => {
    const { root } = await temporaryProject();
    await writeFile(path.join(root, '.env'), 'API_TOKEN=secret\n');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored\n');
    const base = {
      projectId: 'project-1',
      projectRoot: root,
      receivingAdapterId: 'codex',
      receivingProvider: 'OpenAI',
      createdAt: NOW,
    };
    await expect(
      buildAttachmentManifest({ ...base, relativePaths: ['.env'] }),
    ).rejects.toMatchObject({
      code: 'SENSITIVE',
      relativePath: '.env',
    });
    await expect(
      buildAttachmentManifest({
        ...base,
        relativePaths: ['ignored.txt'],
        ignoreMatcher: new IgnoreMatcher([{ name: '.gitignore', content: 'ignored.txt\n' }]),
      }),
    ).rejects.toMatchObject({ code: 'IGNORED', relativePath: 'ignored.txt' });
  });

  it('loads both repository ignore files automatically for default-deny selection', async () => {
    const { root } = await temporaryProject();
    await writeFile(path.join(root, '.gitignore'), '*.generated\n');
    await writeFile(path.join(root, '.forgeboardignore'), 'private-notes.md\n');
    await writeFile(path.join(root, 'code.generated'), 'generated\n');
    await writeFile(path.join(root, 'private-notes.md'), 'notes\n');
    const base = {
      projectId: 'project-1',
      projectRoot: root,
      receivingAdapterId: 'codex',
      receivingProvider: 'OpenAI',
      createdAt: NOW,
    };
    await expect(
      buildAttachmentManifest({ ...base, relativePaths: ['code.generated'] }),
    ).rejects.toMatchObject({ code: 'IGNORED', relativePath: 'code.generated' });
    await expect(
      buildAttachmentManifest({ ...base, relativePaths: ['private-notes.md'] }),
    ).rejects.toMatchObject({ code: 'IGNORED', relativePath: 'private-notes.md' });
  });

  it('permits one exact sensitive path only with a validated high-friction approval', async () => {
    const { root } = await temporaryProject();
    await writeFile(path.join(root, '.env.example'), 'SAFE_PLACEHOLDER=example\n');
    const manifest = await buildAttachmentManifest({
      manifestId: 'manifest-1',
      projectId: 'project-1',
      projectRoot: root,
      receivingAdapterId: 'test-agent',
      receivingProvider: 'Local deterministic test agent',
      relativePaths: ['.env.example'],
      createdAt: NOW,
      overrides: [
        {
          relativePath: '.env.example',
          reason:
            'The user inspected this placeholder-only example file and selected it explicitly.',
          acknowledgement: SENSITIVE_OVERRIDE_ACKNOWLEDGEMENT,
          approvalId: 'approval-1',
          approvedBy: 'user-1',
          approvedAt: NOW,
        },
      ],
    });
    expect(manifest.files[0]).toMatchObject({
      relativePath: '.env.example',
      policy: 'sensitive-override',
      overrideApprovalId: 'approval-1',
    });
  });

  it('rejects duplicate context paths so the disclosure remains unambiguous', async () => {
    const { root } = await temporaryProject();
    await writeFile(path.join(root, 'README.md'), 'read me');
    await expect(
      buildAttachmentManifest({
        projectId: 'project-1',
        projectRoot: root,
        receivingAdapterId: 'test-agent',
        receivingProvider: 'Local',
        relativePaths: ['README.md', './README.md'],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('rejects an in-project symbolic-link alias instead of silently changing its identity', async () => {
    const { root } = await temporaryProject();
    await writeFile(path.join(root, 'source.ts'), 'export const safe = true;\n');
    await symlink(path.join(root, 'source.ts'), path.join(root, 'alias.ts'));

    await expect(
      buildAttachmentManifest({
        projectId: 'project-1',
        projectRoot: root,
        receivingAdapterId: 'test-agent',
        receivingProvider: 'Local',
        relativePaths: ['alias.ts'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_A_FILE', relativePath: 'alias.ts' });
  });
});
