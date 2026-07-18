import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapterManifestSchema, CODEX_MANIFEST } from '@forgeboard/agent-adapters';
import type { App, BrowserWindow, Dialog } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CustomAgentConfigurationSchema,
  type CanvasDocument,
  type Project,
} from '../../shared/application/contracts.js';
import { createBundledGitRepositoryService } from '../git/git-runtime.js';
import { detectAgents, ProjectService } from './project-service.js';
import { LocalStore, type StoredRunRecord } from '../storage.js';
import { sanitizeCanvasDocument } from '../storage/values.js';

const PROJECT_ID = '50000000-0000-4000-8000-000000000001';
const CANVAS_ID = '50000000-0000-4000-8000-000000000002';
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-project-recovery-test-'));
  roots.push(root);
  return root;
}

function openStore(root: string): LocalStore {
  const store = new LocalStore(join(root, 'data', 'forgeboard.sqlite3'));
  stores.add(store);
  return store;
}

function project(path: string): Project {
  return {
    id: PROJECT_ID,
    name: 'repository-before-move',
    path,
    openedAt: '2026-07-14T16:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: false,
      branch: null,
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function canvas(): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Preserved canvas',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-14T16:00:00.000Z',
  };
}

describe('ProjectService moved-project recovery', () => {
  it('parents repository selection and rejects it when the owner changes before persistence', async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, 'selected-repository');
    mkdirSync(repositoryPath);
    const store = openStore(root);
    const parent = { isDestroyed: () => false };
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: [repositoryPath],
    });
    const service = new ProjectService({} as App, { showOpenDialog } as unknown as Dialog, store);
    const assertCurrent = vi.fn(() => {
      throw new Error('The originating Forgeboard window changed or closed.');
    });

    await expect(
      service.pickRepository({
        parent: parent as BrowserWindow,
        assertCurrent,
      }),
    ).rejects.toThrow('window changed');

    expect(showOpenDialog).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({
        properties: ['openDirectory', 'createDirectory'],
      }),
    );
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(store.listProjects()).toEqual([]);
  });

  it('detects package scripts without running them and defaults a lockfile-free project to npm', async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, 'package-project');
    const marker = join(root, 'script-ran');
    mkdirSync(repositoryPath);
    writeFileSync(
      join(repositoryPath, 'package.json'),
      JSON.stringify({
        scripts: {
          dev: `node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`,
          '--unsafe-option': 'exit 1',
        },
      }),
    );
    const store = openStore(root);

    const opened = await new ProjectService({} as App, {} as Dialog, store).open(repositoryPath);

    expect(opened.health).toMatchObject({
      packageManager: 'npm',
    });
    expect(opened.health.scripts.dev).toContain('writeFileSync');
    expect(opened.health.scripts).not.toHaveProperty('--unsafe-option');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors a packageManager declaration without probing that runtime', async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, 'declared-package-project');
    mkdirSync(repositoryPath);
    writeFileSync(
      join(repositoryPath, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.13.1',
        scripts: { preview: 'vite' },
      }),
    );
    const store = openStore(root);

    const opened = await new ProjectService({} as App, {} as Dialog, store).open(repositoryPath);

    expect(opened.health).toMatchObject({
      packageManager: 'pnpm',
      scripts: { preview: 'vite' },
    });
  });

  it('creates an initialized child project with Forgeboard bundled Git', async () => {
    const root = temporaryRoot();
    const parent = join(root, 'projects');
    mkdirSync(parent);
    const store = openStore(root);
    const repositories = createBundledGitRepositoryService();
    const service = new ProjectService({} as App, {} as Dialog, store, repositories);

    const created = await service.create(parent, 'cross-platform-child', true);

    expect(created).toMatchObject({
      name: 'cross-platform-child',
      missing: false,
      health: { isGitRepository: true, branch: 'main', dirty: false },
    });
    expect((await repositories.git.run(['--version'])).executable).toContain('dugite');
  });

  it('initializes an existing folder only after native approval and preserves every file', async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, 'existing-project');
    mkdirSync(repositoryPath);
    const existingFile = join(repositoryPath, 'keep-me.txt');
    writeFileSync(existingFile, 'preserve this exact content\n');
    const store = openStore(root);
    const repositories = createBundledGitRepositoryService();
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 });
    const service = new ProjectService(
      {} as App,
      { showMessageBox } as unknown as Dialog,
      store,
      repositories,
    );
    const opened = await service.open(repositoryPath);

    await expect(service.initializeGit(opened.id)).resolves.toBeNull();
    await expect(access(join(repositoryPath, '.git'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(store.listAuditEvents(1)[0]).toMatchObject({
      category: 'git',
      action: 'initialize',
      outcome: 'denied',
    });

    const initialized = await service.initializeGit(opened.id);
    expect(initialized).toMatchObject({
      id: opened.id,
      health: { isGitRepository: true, branch: 'main', dirty: true },
    });
    expect(readFileSync(existingFile, 'utf8')).toBe('preserve this exact content\n');
    const status = await repositories.status(repositoryPath);
    expect(status.entries).toContainEqual(
      expect.objectContaining({ kind: 'untracked', path: 'keep-me.txt' }),
    );
    expect(showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        buttons: ['Cancel', 'Set up Git'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(store.listAuditEvents(1)[0]).toMatchObject({
      category: 'git',
      action: 'initialize',
      outcome: 'allowed',
    });
    expect(store.exportData().audit.at(-1)?.metadata).toMatchObject({
      existingFilesPreserved: true,
    });
  });

  it('revalidates the project location after approval before creating Git metadata', async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, 'project-before-approval');
    const movedPath = join(root, 'project-after-approval');
    mkdirSync(repositoryPath);
    const store = openStore(root);
    const repositories = createBundledGitRepositoryService();
    const service = new ProjectService(
      {} as App,
      {
        showMessageBox: vi.fn().mockImplementation(() => {
          renameSync(repositoryPath, movedPath);
          return Promise.resolve({ response: 1 });
        }),
      } as unknown as Dialog,
      store,
      repositories,
    );
    const opened = await service.open(repositoryPath);

    await expect(service.initializeGit(opened.id)).rejects.toThrow(
      'selected project is no longer available',
    );
    await expect(access(join(movedPath, '.git'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(store.listAuditEvents(1)[0]).toMatchObject({
      category: 'git',
      action: 'initialize',
      outcome: 'failed',
    });
  });

  it('marks a missing path and explicitly rebinds the same project to a vetted directory', async () => {
    const root = temporaryRoot();
    const originalPath = join(root, 'repository-before-move');
    const movedPath = join(root, 'repository-after-move');
    mkdirSync(originalPath);
    const canonicalOriginal = await realpath(originalPath);
    const store = openStore(root);
    store.saveProject(project(canonicalOriginal));
    store.saveCanvas(canvas());
    const run: StoredRunRecord = {
      id: '50000000-0000-4000-8000-000000000004',
      projectId: PROJECT_ID,
      nodeId: 'agent-node',
      adapterId: 'test-agent',
      status: 'succeeded',
      cwd: canonicalOriginal,
      branch: null,
      worktreeId: null,
      worktreeState: 'active',
      worktreeAuthority: 'owned',
      repositoryRoot: canonicalOriginal,
      managedRoot: null,
      baseRef: null,
      baseCommit: null,
      startedAt: '2026-07-14T16:00:00.000Z',
      endedAt: '2026-07-14T16:01:00.000Z',
      exitCode: 0,
      createdAt: '2026-07-14T16:00:00.000Z',
      updatedAt: '2026-07-14T16:01:00.000Z',
    };
    store.saveRun(run);
    renameSync(originalPath, movedPath);

    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [movedPath] });
    const service = new ProjectService({} as App, { showOpenDialog } as unknown as Dialog, store);
    expect(await service.refreshRecentProjects()).toEqual([
      expect.objectContaining({ id: PROJECT_ID, missing: true }),
    ]);
    const assessment = await service.selectMovedProject(PROJECT_ID);
    expect(assessment).toMatchObject({
      projectId: PROJECT_ID,
      original: { name: 'repository-before-move', path: canonicalOriginal },
      candidate: {
        name: 'repository-after-move',
        path: await realpath(movedPath),
      },
      warnings: [],
    });
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: ['openDirectory'],
        buttonLabel: 'Check this folder',
      }),
    );
    expect(store.getProject(PROJECT_ID)).toMatchObject({
      path: canonicalOriginal,
      missing: true,
    });

    if (!assessment) throw new Error('Expected a recovery assessment.');
    const recovered = await service.confirmMovedProject({
      projectId: PROJECT_ID,
      confirmationId: assessment.confirmationId,
      confirmed: true,
    });
    expect(recovered).toMatchObject({
      id: PROJECT_ID,
      name: 'repository-after-move',
      missing: false,
      path: await realpath(movedPath),
    });
    expect(store.loadCanvas(PROJECT_ID)).toEqual(sanitizeCanvasDocument(canvas()));
    expect(store.exportData().runs).toContainEqual(run);
    expect(store.listAuditEvents(1)[0]).toMatchObject({
      category: 'project',
      action: 'recover-moved',
    });
  });

  it('rejects a recovery candidate already owned by another recent project', async () => {
    const root = temporaryRoot();
    const missingPath = join(root, 'missing-repository');
    const occupiedPath = join(root, 'occupied-repository');
    mkdirSync(occupiedPath);
    const store = openStore(root);
    store.saveProject({ ...project(missingPath), missing: true });
    store.saveProject({
      ...project(await realpath(occupiedPath)),
      id: '50000000-0000-4000-8000-000000000003',
      name: 'occupied-repository',
    });
    const service = new ProjectService({} as App, {} as Dialog, store);

    await expect(service.inspectRecoveryCandidate(PROJECT_ID, occupiedPath)).rejects.toThrow(
      'already belongs to another recent project',
    );
    expect(store.getProject(PROJECT_ID)?.path).toBe(missingPath);
  });

  it('rejects forged confirmations and candidate changes without rebinding the project', async () => {
    const root = temporaryRoot();
    const missingPath = join(root, 'missing-repository');
    const candidatePath = join(root, 'candidate-repository');
    mkdirSync(candidatePath);
    const store = openStore(root);
    store.saveProject({ ...project(missingPath), missing: true });
    const service = new ProjectService(
      {} as App,
      {
        showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [candidatePath] }),
      } as unknown as Dialog,
      store,
    );

    const assessment = await service.selectMovedProject(PROJECT_ID);
    if (!assessment) throw new Error('Expected a recovery assessment.');
    await expect(
      service.confirmMovedProject({
        projectId: PROJECT_ID,
        confirmationId: '50000000-0000-4000-8000-000000000099',
        confirmed: true,
      }),
    ).rejects.toThrow('no longer valid');
    expect(store.getProject(PROJECT_ID)).toMatchObject({
      path: missingPath,
      missing: true,
    });

    writeFileSync(
      join(candidatePath, 'package.json'),
      JSON.stringify({ dependencies: { react: '19.0.0' } }),
    );
    await expect(
      service.confirmMovedProject({
        projectId: PROJECT_ID,
        confirmationId: assessment.confirmationId,
        confirmed: true,
      }),
    ).rejects.toThrow('changed after review');
    expect(store.getProject(PROJECT_ID)).toMatchObject({
      path: missingPath,
      missing: true,
    });
  });

  it('reopens a repository outside the recent-30 window without replacing its identity or history', async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, 'long-term-repository');
    mkdirSync(repositoryPath);
    const canonicalRepository = await realpath(repositoryPath);
    const store = openStore(root);
    store.saveProject(project(canonicalRepository));
    store.saveCanvas(canvas());
    const run: StoredRunRecord = {
      id: '50000000-0000-4000-8000-000000000004',
      projectId: PROJECT_ID,
      nodeId: 'agent-node',
      adapterId: 'test-agent',
      status: 'succeeded',
      cwd: canonicalRepository,
      branch: null,
      worktreeId: null,
      worktreeState: 'active',
      worktreeAuthority: 'owned',
      repositoryRoot: canonicalRepository,
      managedRoot: null,
      baseRef: null,
      baseCommit: null,
      startedAt: '2026-07-14T16:00:00.000Z',
      endedAt: '2026-07-14T16:01:00.000Z',
      exitCode: 0,
      createdAt: '2026-07-14T16:00:00.000Z',
      updatedAt: '2026-07-14T16:01:00.000Z',
    };
    store.saveRun(run);
    for (let index = 1; index <= 31; index += 1) {
      store.saveProject({
        ...project(join(root, `newer-${index}`)),
        id: `50000000-0000-4000-8001-${index.toString().padStart(12, '0')}`,
        openedAt: new Date(Date.UTC(2026, 6, 15, 0, 0, index)).toISOString(),
      });
    }
    expect(store.listProjects().some((entry) => entry.id === PROJECT_ID)).toBe(false);

    const reopened = await new ProjectService({} as App, {} as Dialog, store).open(repositoryPath);
    expect(reopened.id).toBe(PROJECT_ID);
    expect(store.loadCanvas(PROJECT_ID)).toEqual(sanitizeCanvasDocument(canvas()));
    expect(store.exportData().runs).toContainEqual(run);
    expect(store.exportData().projects).toHaveLength(32);
  });
});

describe('trusted extension adapter detection', () => {
  it('treats a valid executable chosen in Settings as installed even when it is off PATH', async () => {
    const detections = await detectAgents('/tmp/not-used-test-agent', [], {
      codex: process.execPath,
    });

    expect(detections.find((detection) => detection.id === 'codex')).toMatchObject({
      installed: true,
      executable: await realpath(process.execPath),
      version: null,
      capabilitySource: 'manifest',
      capabilities: { modelSelection: true },
    });
  }, 15_000);

  it.skipIf(process.platform === 'win32')(
    'never invokes a renderer-configured built-in executable during passive detection',
    async () => {
      const root = temporaryRoot();
      const marker = join(root, 'configured-built-in-ran');
      const executable = join(root, 'configured-codex');
      writeFileSync(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      chmodSync(executable, 0o755);

      const detections = await detectAgents('/tmp/not-used-test-agent', [], {
        codex: executable,
      });

      expect(detections.find((detection) => detection.id === 'codex')).toMatchObject({
        installed: true,
        executable: await realpath(executable),
        version: null,
      });
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('detects the UI-built custom CLI passively without executing its version arguments', async () => {
    const root = temporaryRoot();
    const probeMarker = join(root, 'custom-version-probe-ran');
    const customAgent = CustomAgentConfigurationSchema.parse({
      enabled: true,
      name: 'Custom local Node',
      providerName: 'Local fixture',
      providerDisclosure: 'This fixture stays local.',
      sendsContextOffDevice: false,
      executable: process.execPath,
      versionArguments: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(probeMarker)}, 'ran')`,
      ],
    });

    const detections = await detectAgents('/tmp/not-used-test-agent', [], {}, customAgent);

    expect(detections.find((detection) => detection.id === 'custom')).toMatchObject({
      label: 'Custom local Node',
      installed: true,
      executable: await realpath(process.execPath),
      version: null,
      capabilitySource: 'manifest',
      capabilities: { modelSelection: false },
    });
    await expect(access(probeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('locates a validated namespaced adapter without running extension-controlled probes', async () => {
    const root = temporaryRoot();
    const probeMarker = join(root, 'extension-probe-ran');
    const manifest = AgentAdapterManifestSchema.parse({
      ...CODEX_MANIFEST,
      id: 'example.tools.node',
      name: 'Example Node adapter',
      provider: {
        ...CODEX_MANIFEST.provider,
        name: 'Example provider',
        disclosure: 'Example provider disclosure shown before every launch.',
      },
      executable: {
        ...CODEX_MANIFEST.executable,
        command: process.execPath,
        versionArguments: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(probeMarker)}, 'ran')`,
        ],
        capabilityProbe: {
          arguments: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(probeMarker)}, 'ran')`,
          ],
          permissionModes: {
            'plan-read-only': ['--sandbox'],
          },
        },
      },
    });

    const detections = await detectAgents('/tmp/not-used-test-agent', [manifest]);
    const extension = detections.find((detection) => detection.id === manifest.id);

    expect(extension).toMatchObject({
      id: 'example.tools.node',
      label: 'Example Node adapter',
      installed: true,
      executable: process.execPath,
      providerDisclosure: 'Example provider disclosure shown before every launch.',
      capabilitySource: 'manifest',
      capabilities: { modelSelection: true },
    });
    expect(extension?.version).toBeNull();
    await expect(access(probeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('native local reference selection', () => {
  it('returns only canonical paths of the requested type from a main-owned chooser', async () => {
    const root = temporaryRoot();
    const file = join(root, 'context.txt');
    const directory = join(root, 'context');
    writeFileSync(file, 'context');
    mkdirSync(directory);
    const showOpenDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: [file] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [directory] });
    const service = new ProjectService(
      {} as App,
      { showOpenDialog } as unknown as Dialog,
      {} as LocalStore,
    );

    await expect(service.pickReferences({ kind: 'file', multiple: false })).resolves.toEqual([
      await realpath(file),
    ]);
    await expect(service.pickReferences({ kind: 'directory', multiple: false })).resolves.toEqual([
      await realpath(directory),
    ]);
    expect(showOpenDialog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ properties: ['openFile'] }),
    );
    expect(showOpenDialog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ properties: ['openDirectory'] }),
    );
  });
});
