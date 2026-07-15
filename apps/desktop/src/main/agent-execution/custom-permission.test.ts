import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CustomPermissionProfileSettingsSchema,
  type CustomPermissionProfileSettings,
} from '../../shared/application/contracts.js';
import {
  assertCustomAttachmentsWithinReadRoots,
  resolveCustomDockerPermission,
  resolveCustomHostPermission,
} from './custom-permission.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('Custom permission resolution', () => {
  it('keeps host roots local, discloses limits, and injects only relative policy paths', async () => {
    const cwd = await fixtureRoot();
    const permission = await resolveCustomHostPermission(
      hostProfile(),
      cwd,
      process.execPath,
      'Inspect the project.',
    );

    expect(permission.profile).toMatchObject({
      mode: 'custom',
      enforcement: 'disclosure-only',
      network: 'provider-controlled',
      readRoots: [cwd],
      writeRoots: [],
      custom: { runtime: 'host', allowedLaunchExecutables: [process.execPath] },
    });
    expect(permission.prompt).toContain('relative to the assigned worktree: .');
    expect(permission.prompt).not.toContain(cwd);
    expect(permission.profile.disclosure).toContain('not an operating-system filesystem sandbox');
  });

  it('canonicalizes explicit folder roots and rejects context outside readable roots', async () => {
    const cwd = await fixtureRoot();
    await mkdir(path.join(cwd, 'src', 'generated'), { recursive: true });
    await writeFile(path.join(cwd, 'src', 'inside.ts'), 'inside\n');
    await writeFile(path.join(cwd, 'outside.ts'), 'outside\n');
    const permission = await resolveCustomHostPermission(
      hostProfile({
        filesystem: 'explicit-paths',
        readPaths: ['src'],
        writePaths: ['src/generated'],
      }),
      cwd,
      process.execPath,
      'Work in src.',
    );

    expect(() =>
      assertCustomAttachmentsWithinReadRoots(permission, [
        { path: path.join(cwd, 'src', 'inside.ts'), kind: 'file', explicitlyApproved: true },
      ]),
    ).not.toThrow();
    expect(() =>
      assertCustomAttachmentsWithinReadRoots(permission, [
        { path: path.join(cwd, 'outside.ts'), kind: 'file', explicitlyApproved: true },
      ]),
    ).toThrow(/outside every readable/iu);
  });

  it('rejects file roots, symbolic-link roots, and duplicate canonical allowlist aliases', async () => {
    const cwd = await fixtureRoot();
    await writeFile(path.join(cwd, 'not-a-folder'), 'file\n');
    await mkdir(path.join(cwd, 'real-folder'));
    await symlink(path.join(cwd, 'real-folder'), path.join(cwd, 'linked-folder'));
    await expect(
      resolveCustomHostPermission(
        hostProfile({ filesystem: 'explicit-paths', readPaths: ['not-a-folder'] }),
        cwd,
        process.execPath,
        'Inspect.',
      ),
    ).rejects.toThrow(/not a folder/iu);
    await expect(
      resolveCustomHostPermission(
        hostProfile({ filesystem: 'explicit-paths', readPaths: ['linked-folder'] }),
        cwd,
        process.execPath,
        'Inspect.',
      ),
    ).rejects.toThrow(/symbolic link/iu);

    const alias = path.join(cwd, 'node-alias');
    await symlink(process.execPath, alias);
    await expect(
      resolveCustomHostPermission(
        hostProfile({
          executablePolicy: 'allowlist',
          allowedExecutables: [process.execPath, alias],
        }),
        cwd,
        process.execPath,
        'Inspect.',
      ),
    ).rejects.toThrow(/distinct executable/iu);
  });

  it('discloses enforceable Docker resources and the exact in-container entrypoint', async () => {
    const cwd = await fixtureRoot();
    const settings = CustomPermissionProfileSettingsSchema.parse({
      runtime: 'docker',
      filesystem: 'assigned-worktree-write',
      readPaths: ['.'],
      writePaths: ['.'],
      ignoredFileRead: 'allow',
      sensitiveFileRead: 'allow',
      executablePolicy: 'allowlist',
      allowedExecutables: ['/usr/local/bin/codex'],
      docker: { network: 'enabled', cpuLimit: 3, memoryMb: 2_048 },
    });
    const permission = await resolveCustomDockerPermission(
      settings,
      cwd,
      '/usr/local/bin/codex',
      'Implement the task.',
    );

    expect(permission.profile).toMatchObject({
      mode: 'custom',
      enforcement: 'docker',
      network: 'allowed',
      custom: {
        runtime: 'docker',
        allowedLaunchExecutables: ['/usr/local/bin/codex'],
        docker: { network: 'enabled', cpuLimit: 3, memoryMb: 2_048 },
      },
    });
  });
});

function hostProfile(
  overrides: Partial<CustomPermissionProfileSettings> = {},
): CustomPermissionProfileSettings {
  return CustomPermissionProfileSettingsSchema.parse({
    runtime: 'host',
    filesystem: 'assigned-worktree-read-only',
    readPaths: ['.'],
    writePaths: [],
    ignoredFileRead: 'deny',
    sensitiveFileRead: 'deny',
    executablePolicy: 'selected-agent-only',
    allowedExecutables: [],
    ...overrides,
  });
}

async function fixtureRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-custom-permission-'));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return await realpath(directory);
}
