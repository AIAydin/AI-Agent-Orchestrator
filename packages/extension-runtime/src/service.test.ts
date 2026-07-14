import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EXTENSION_APPROVAL_MAX_AGE_MS,
  EXTENSION_APPROVAL_MAX_FUTURE_SKEW_MS,
  ExtensionRuntimeError,
  LocalExtensionService,
  compareSemanticVersions,
  createExtensionApproval,
} from './service.js';
import { exampleCanvasExtension } from './test-fixtures.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forgeboard-extension-test-'));
  temporaryRoots.push(root);
  return root;
}

async function writeExtensionSource(
  root: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const source = path.join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, 'forgeboard-extension.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return source;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('LocalExtensionService', () => {
  it('plans, explicitly approves, installs, discovers, updates, and removes a snapshot', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, {
      ...exampleCanvasExtension(),
      documentationFile: 'README.md',
    });
    await writeFile(path.join(source, 'README.md'), '# Extension help\n', 'utf8');
    const service = new LocalExtensionService(path.join(root, 'registry'));

    const plan = await service.planFromSelectedPath(source);
    const approval = createExtensionApproval(plan, {
      confirmed: true,
      permissions: plan.requestedPermissions,
    });
    const installed = await service.install(plan, approval);

    expect(installed.manifest.id).toBe('example.notes');
    expect(installed.documentationText).toBe('# Extension help\n');
    expect(installed.record.grantedPermissions).toEqual([
      'canvas.data.persist',
      'canvas.node.register',
    ]);
    expect(installed.record.snapshotDigest).toBe(plan.snapshotDigest);
    const discovery = await service.discover();
    expect(discovery.invalid).toEqual([]);
    expect(discovery.installed).toHaveLength(1);
    expect(discovery.installed[0]?.manifest.version).toBe('1.0.0');

    await writeFile(
      path.join(source, 'forgeboard-extension.json'),
      `${JSON.stringify(
        { ...exampleCanvasExtension('1.1.0'), documentationFile: 'README.md' },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const updatePlan = await service.planFromSelectedPath(
      path.join(source, 'forgeboard-extension.json'),
    );
    const updated = await service.update(
      'example.notes',
      updatePlan,
      createExtensionApproval(updatePlan, {
        confirmed: true,
        permissions: updatePlan.requestedPermissions,
      }),
    );
    expect(updated.manifest.version).toBe('1.1.0');
    expect(updated.record.installedAt).toBe(installed.record.installedAt);

    expect(await service.remove('example.notes')).toBe(true);
    expect(await service.remove('example.notes')).toBe(false);
    expect((await service.discover()).installed).toEqual([]);
  });

  it('atomically purges the private registry and recreates an empty root', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, exampleCanvasExtension());
    const registry = path.join(root, 'registry');
    const service = new LocalExtensionService(registry);
    const plan = await service.planFromSelectedPath(source);
    await service.install(
      plan,
      createExtensionApproval(plan, {
        confirmed: true,
        permissions: plan.requestedPermissions,
      }),
    );

    await service.purgeAll();

    expect((await service.discover()).installed).toEqual([]);
    expect((await stat(registry)).isDirectory()).toBe(true);
    await expect(service.remove('example.notes')).resolves.toBe(false);
  });

  it('rejects malformed JSON without creating registry state', async () => {
    const root = await temporaryRoot();
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'forgeboard-extension.json'), '{not-json', 'utf8');
    const service = new LocalExtensionService(path.join(root, 'registry'));

    await expect(service.planFromSelectedPath(source)).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    });
  });

  it('rejects a selected symlink and documentation symlink escaping the selected root', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, {
      ...exampleCanvasExtension(),
      documentationFile: 'docs/help.md',
    });
    const outside = path.join(root, 'outside.md');
    await writeFile(outside, 'outside', 'utf8');
    await mkdir(path.join(source, 'docs'));
    await symlink(outside, path.join(source, 'docs', 'help.md'), 'file');
    const service = new LocalExtensionService(path.join(root, 'registry'));

    await expect(service.planFromSelectedPath(source)).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });

    const selectedLink = path.join(root, 'selected-link');
    await symlink(source, selectedLink, 'dir');
    await expect(service.planFromSelectedPath(selectedLink)).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
    await expect(service.remove('../outside')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  it('requires approval to match the exact digest and least-privilege permission set', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, exampleCanvasExtension());
    const service = new LocalExtensionService(path.join(root, 'registry'));
    const plan = await service.planFromSelectedPath(source);

    await expect(
      service.install(plan, {
        extensionId: plan.manifest.id,
        version: plan.manifest.version,
        manifestDigest: '0'.repeat(64),
        snapshotDigest: plan.snapshotDigest,
        permissions: ['canvas.node.register'],
        confirmed: true,
        approvedAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(ExtensionRuntimeError);

    const validApproval = createExtensionApproval(plan, {
      confirmed: true,
      permissions: plan.requestedPermissions,
    });
    const mutatedPlan = {
      ...plan,
      manifest: { ...plan.manifest, name: 'Changed after approval' },
    };
    await expect(service.install(mutatedPlan, validApproval)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
    });
    expect((await service.discover()).installed).toEqual([]);
  });

  it('reports tampered registry entries instead of loading them', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, exampleCanvasExtension());
    const registry = path.join(root, 'registry');
    const service = new LocalExtensionService(registry);
    const plan = await service.planFromSelectedPath(source);
    await service.install(
      plan,
      createExtensionApproval(plan, {
        confirmed: true,
        permissions: plan.requestedPermissions,
      }),
    );

    const installedManifestPath = path.join(registry, 'example.notes', 'manifest.json');
    const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8')) as {
      name: string;
    };
    installedManifest.name = 'Tampered';
    await writeFile(installedManifestPath, JSON.stringify(installedManifest), 'utf8');

    const discovery = await service.discover();
    expect(discovery.installed).toEqual([]);
    expect(discovery.invalid).toEqual([expect.objectContaining({ entryName: 'example.notes' })]);
  });

  it('binds approval and discovery to the exact documentation snapshot', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, {
      ...exampleCanvasExtension(),
      documentationFile: 'README.md',
    });
    await writeFile(path.join(source, 'README.md'), '# Trusted documentation\n', 'utf8');
    const registry = path.join(root, 'registry');
    const service = new LocalExtensionService(registry);
    const plan = await service.planFromSelectedPath(source);
    const approval = createExtensionApproval(plan, {
      confirmed: true,
      permissions: plan.requestedPermissions,
    });

    await expect(
      service.install({ ...plan, documentationText: '# Changed after approval\n' }, approval),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });

    await service.install(plan, approval);
    await writeFile(
      path.join(registry, 'example.notes', 'documentation.txt'),
      '# Changed after install\n',
      'utf8',
    );
    const discovery = await service.discover();
    expect(discovery.installed).toEqual([]);
    expect(discovery.invalid).toHaveLength(1);
    expect(discovery.invalid[0]?.entryName).toBe('example.notes');
    expect(discovery.invalid[0]?.reason).toContain('snapshot digest');
  });

  it('rejects stale approvals and timestamps beyond the permitted future skew', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, exampleCanvasExtension());
    const now = new Date('2026-07-14T16:00:00.000Z');
    const service = new LocalExtensionService(path.join(root, 'registry'), () => now);
    const plan = await service.planFromSelectedPath(source);
    const decision = {
      confirmed: true as const,
      permissions: plan.requestedPermissions,
    };
    const staleApproval = createExtensionApproval(
      plan,
      decision,
      new Date(now.getTime() - EXTENSION_APPROVAL_MAX_AGE_MS - 1),
    );
    const futureApproval = createExtensionApproval(
      plan,
      decision,
      new Date(now.getTime() + EXTENSION_APPROVAL_MAX_FUTURE_SKEW_MS + 1),
    );

    await expect(service.install(plan, staleApproval)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
      message: 'Approval is stale. Review and approve a fresh plan.',
    });
    await expect(service.install(plan, futureApproval)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
      message: 'Approval timestamp is too far in the future. Review and approve a fresh plan.',
    });
    expect((await service.discover()).installed).toEqual([]);
  });

  it('denies same-version updates and downgrades', async () => {
    const root = await temporaryRoot();
    const source = await writeExtensionSource(root, exampleCanvasExtension('2.0.0'));
    const service = new LocalExtensionService(path.join(root, 'registry'));
    const plan = await service.planFromSelectedPath(source);
    const approve = () =>
      createExtensionApproval(plan, {
        confirmed: true,
        permissions: plan.requestedPermissions,
      });
    await service.install(plan, approve());

    await expect(service.update('example.notes', plan, approve())).rejects.toMatchObject({
      code: 'DOWNGRADE_DENIED',
    });
    expect(compareSemanticVersions('1.9.9', '2.0.0')).toBeLessThan(0);
    expect(compareSemanticVersions('2.0.0-beta.2', '2.0.0-beta.11')).toBeLessThan(0);
    expect(compareSemanticVersions('2.0.0', '2.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemanticVersions('2.0.0-ALPHA', '2.0.0-alpha')).toBeLessThan(0);
    expect(compareSemanticVersions('2.0.0+build.1', '2.0.0+build.2')).toBe(0);
    expect(() => compareSemanticVersions('2.0.0-01', '2.0.0')).toThrow();
  });
});
