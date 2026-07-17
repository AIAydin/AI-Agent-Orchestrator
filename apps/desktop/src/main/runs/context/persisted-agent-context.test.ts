import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AppSettings,
  CanvasDocument,
  PrepareRunInput,
  Project,
} from '../../../shared/application/contracts.js';
import {
  assertPersistedAgentLaunchAuthorityCurrent,
  PersistedAgentRunContextResolver,
} from './persisted-agent-context.js';

const PROJECT_ID = '123fae6e-e213-4a10-a0db-0f85b791f7e9';
const OTHER_PROJECT_ID = '223fae6e-e213-4a10-a0db-0f85b791f7e9';
const NOW = '2026-07-15T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PersistedAgentRunContextResolver', () => {
  it('resolves only persisted opaque File-node IDs into a stable hashed authority', async () => {
    const root = fixtureRoot();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'context.ts'), 'export const context = true;\n');
    const appendAudit = vi.fn();
    const resolver = resolverFor(
      root,
      canvas(['file-1'], [fileNode('file-1', 'src/context.ts')]),
      appendAudit,
    );

    const first = await resolver.resolve(input(), settings());
    const second = await resolver.resolve(input(), settings());

    expect(first.context.attachments).toEqual([
      expect.objectContaining({
        path: path.join(root, 'src', 'context.ts'),
        kind: 'file',
        label: 'Context file',
        explicitlyApproved: true,
      }),
    ]);
    expect(first.context.attachments[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.context.manifestId).toBeTypeOf('string');
    expect(first.context.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.authority).toMatchObject({
      attachmentIds: ['file-1'],
      canvasId: 'canvas-1',
      relativePaths: ['src/context.ts'],
      manifestDigest: first.context.manifestDigest,
    });
    expect(second.authority.fingerprint).toBe(first.authority.fingerprint);
    expect(second.context.manifestId).not.toBe(first.context.manifestId);
    expect(appendAudit).toHaveBeenCalledWith(
      'agent-run-context',
      'resolve',
      'allowed',
      expect.objectContaining({ attachmentIds: ['file-1'] }),
    );
  });

  it.each([
    ['prompt', input({ prompt: 'Different prompt' })],
    ['adapter', input({ adapterId: 'codex' })],
    ['model', input({ model: 'different-model' })],
    ['permission profile', input({ permissionProfile: 'worktree-write' })],
  ] as const)(
    'requires the persisted Agent %s to match the reviewed request',
    async (_label, request) => {
      const root = fixtureRoot();
      const resolver = resolverFor(root, canvas([], []));
      await expect(resolver.resolve(request, settings())).rejects.toThrow(/saved Agent/iu);
    },
  );

  it('binds the persisted Agent model into immutable run authority', async () => {
    const root = fixtureRoot();
    const nodeModel = await resolverFor(
      root,
      canvas([], [], { adapterId: 'codex', model: 'node-model' }),
    ).resolve(input({ adapterId: 'codex', model: 'node-model' }), settings());
    const otherModel = await resolverFor(
      root,
      canvas([], [], { adapterId: 'codex', model: 'other-model' }),
    ).resolve(input({ adapterId: 'codex', model: 'other-model' }), settings());

    expect(nodeModel.authority.fingerprint).not.toBe(otherModel.authority.fingerprint);
  });

  it('denies a locked Agent and an Agent inherited by a locked group', async () => {
    const root = fixtureRoot();
    await expect(
      resolverFor(root, canvas([], [], { locked: true })).resolve(input(), settings()),
    ).rejects.toThrow(/unlock the Agent/iu);
    await expect(
      resolverFor(root, canvas([], [groupNode('group-1', ['agent-1'], true)])).resolve(
        input(),
        settings(),
      ),
    ).rejects.toThrow(/containing group/iu);
  });

  it('binds final launch authority to the current persisted run on the exact Agent node', () => {
    const runId = '00000000-0000-4000-8000-000000000001';
    let document = canvas([], [], { runId });
    const store = { loadCanvas: () => document };
    const authority = {
      attachmentIds: [],
      canvasId: 'canvas-1',
      fingerprint: 'a'.repeat(64),
      manifestDigest: null,
      relativePaths: [],
    };

    expect(() =>
      assertPersistedAgentLaunchAuthorityCurrent(store, input(), settings(), runId, authority),
    ).not.toThrow();
    document = canvas([], [], {
      runId: '00000000-0000-4000-8000-000000000002',
    });
    expect(() =>
      assertPersistedAgentLaunchAuthorityCurrent(store, input(), settings(), runId, authority),
    ).toThrow(/another run/iu);
  });

  it('matches the visible description fallback when a legacy Agent has no prompt field', async () => {
    const root = fixtureRoot();
    const legacy = canvas([], [], {
      prompt: null,
      description: 'Visible fallback prompt',
    });

    await expect(
      resolverFor(root, legacy).resolve(input({ prompt: 'Visible fallback prompt' }), settings()),
    ).resolves.toBeDefined();
    await expect(
      resolverFor(root, legacy).resolve(input({ prompt: 'Different prompt' }), settings()),
    ).rejects.toThrow(/saved Agent prompt/iu);
  });

  it('denies unresolved, duplicate, cross-project, missing, and directory File-node references', async () => {
    const root = fixtureRoot();
    const cases: CanvasDocument[] = [
      canvas(['unknown'], []),
      canvas(['file-1', 'file-1'], [fileNode('file-1', 'same.ts')]),
      canvas(['file-1'], [fileNode('file-1', 'other.ts', { projectId: OTHER_PROJECT_ID })]),
      canvas(['file-1'], [fileNode('file-1', 'missing.ts', { missing: true })]),
      canvas(['file-1'], [fileNode('file-1', 'folder', { kind: 'directory' })]),
      canvas(['file-1', 'file-2'], [fileNode('file-1', 'same.ts'), fileNode('file-2', 'same.ts')]),
    ];

    for (const document of cases) {
      await expect(resolverFor(root, document).resolve(input(), settings())).rejects.toThrow();
    }
  });

  it('denies missing project/canvas authority, non-Agent targets, traversal, and over-limit links', async () => {
    const root = fixtureRoot();
    const appendAudit = vi.fn();
    await expect(
      new PersistedAgentRunContextResolver({
        getProject: () => undefined,
        loadCanvas: () => undefined,
        appendAudit,
      }).resolve(input(), settings()),
    ).rejects.toThrow();
    await expect(
      new PersistedAgentRunContextResolver({
        getProject: () => ({ ...project(root), missing: true }),
        loadCanvas: () => canvas([], []),
        appendAudit,
      }).resolve(input(), settings()),
    ).rejects.toThrow();
    await expect(
      new PersistedAgentRunContextResolver({
        getProject: () => project(root),
        loadCanvas: () => undefined,
        appendAudit,
      }).resolve(input(), settings()),
    ).rejects.toThrow(/save this canvas/iu);

    const nonAgent = canvas([], [fileNode('file-1', 'file.ts')]);
    await expect(
      resolverFor(root, nonAgent).resolve(input({ nodeId: 'file-1' }), settings()),
    ).rejects.toThrow(/exact persisted Agent/iu);
    await expect(
      resolverFor(root, canvas(['file-1'], [fileNode('file-1', '../../outside.ts')])).resolve(
        input(),
        settings(),
      ),
    ).rejects.toThrow();

    const attachmentIds = Array.from({ length: 257 }, (_, index) => `file-${String(index)}`);
    await expect(
      resolverFor(root, canvas(attachmentIds, [])).resolve(input(), settings()),
    ).rejects.toThrow();
  });

  it('denies sensitive, ignored, and symbolic-link aliased files', async () => {
    const root = fixtureRoot();
    writeFileSync(path.join(root, '.env'), 'TOKEN=secret\n');
    writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(path.join(root, 'ignored.txt'), 'ignored\n');
    writeFileSync(path.join(root, '.forgeboardignore'), 'private.txt\n');
    writeFileSync(path.join(root, 'private.txt'), 'private\n');
    writeFileSync(path.join(root, 'real.ts'), 'export {};\n');
    symlinkSync(path.join(root, 'real.ts'), path.join(root, 'alias.ts'));

    for (const relativePath of ['.env', 'ignored.txt', 'private.txt', 'alias.ts']) {
      const document = canvas(['file-1'], [fileNode('file-1', relativePath)]);
      await expect(resolverFor(root, document).resolve(input(), settings())).rejects.toThrow();
    }
  });

  it('changes its authority fingerprint when selected file bytes change', async () => {
    const root = fixtureRoot();
    writeFileSync(path.join(root, 'context.md'), 'before\n');
    const resolver = resolverFor(root, canvas(['file-1'], [fileNode('file-1', 'context.md')]));
    const before = await resolver.resolve(input(), settings());

    writeFileSync(path.join(root, 'context.md'), 'after\n');
    const after = await resolver.resolve(input(), settings());

    expect(after.authority.fingerprint).not.toBe(before.authority.fingerprint);
    expect(after.context.attachments[0]?.sha256).not.toBe(before.context.attachments[0]?.sha256);
  });

  it('binds File-node labels and UI defaults into the authority fingerprint', async () => {
    const root = fixtureRoot();
    writeFileSync(path.join(root, 'context.md'), 'stable bytes\n');
    const first = await resolverFor(
      root,
      canvas(['file-1'], [fileNode('file-1', 'context.md', { title: 'Original label' })]),
    ).resolve(input(), settings());
    const renamed = await resolverFor(
      root,
      canvas(['file-1'], [fileNode('file-1', 'context.md', { title: 'Renamed label' })]),
    ).resolve(input(), settings());
    expect(renamed.authority.fingerprint).not.toBe(first.authority.fingerprint);

    const defaultsDocument = canvas([], [], {
      adapterId: null,
      permissionProfile: null,
    });
    await expect(
      resolverFor(root, defaultsDocument).resolve(input(), settings()),
    ).resolves.toBeDefined();
    await expect(
      resolverFor(root, defaultsDocument).resolve(input(), {
        ...settings(),
        defaultAgent: 'codex',
        defaultPermissionProfile: 'worktree-write',
      }),
    ).rejects.toThrow(/saved Agent adapter/iu);
    await expect(
      resolverFor(root, defaultsDocument).resolve(input(), {
        ...settings(),
        defaultPermissionProfile: 'worktree-write',
      }),
    ).rejects.toThrow(/saved Agent permission profile/iu);
  });
});

function resolverFor(
  root: string,
  document: CanvasDocument,
  appendAudit = vi.fn(),
): PersistedAgentRunContextResolver {
  return new PersistedAgentRunContextResolver({
    getProject: () => project(root),
    loadCanvas: () => document,
    appendAudit,
  });
}

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'forgeboard-direct-context-')));
  roots.push(root);
  return root;
}

function input(overrides: Partial<PrepareRunInput> = {}): PrepareRunInput {
  return {
    projectId: PROJECT_ID,
    nodeId: 'agent-1',
    adapterId: 'test-agent',
    prompt: 'Review context',
    permissionProfile: 'plan-read-only',
    ...overrides,
  };
}

function settings(): AppSettings {
  return {
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'plan-read-only',
  } as AppSettings;
}

function project(root: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Fixture',
    path: root,
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
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

function canvas(
  attachmentIds: string[],
  files: CanvasDocument['nodes'],
  agentOverrides: Readonly<Record<string, unknown>> = {},
): CanvasDocument {
  return {
    id: 'canvas-1',
    projectId: PROJECT_ID,
    name: 'Canvas',
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 300, y: 100 },
        data: {
          kind: 'agent',
          title: 'Agent',
          description: 'Agent description',
          status: 'idle',
          locked: false,
          collapsed: false,
          color: '#445566',
          adapterId: 'test-agent',
          permissionProfile: 'plan-read-only',
          prompt: 'Review context',
          contextAttachmentIds: attachmentIds,
          ...agentOverrides,
        },
      },
      ...files,
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  };
}

function fileNode(
  id: string,
  relativePath: string,
  overrides: Partial<{
    readonly projectId: string;
    readonly kind: 'file' | 'directory';
    readonly missing: boolean;
    readonly title: string;
  }> = {},
): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'file',
    position: { x: 0, y: 0 },
    data: {
      kind: 'file',
      title: overrides.title ?? 'Context file',
      description: 'File',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#667788',
      file: {
        projectId: overrides.projectId ?? PROJECT_ID,
        relativePath,
        kind: overrides.kind ?? 'file',
        missing: overrides.missing ?? false,
      },
    },
  };
}

function groupNode(
  id: string,
  childNodeIds: string[],
  locked: boolean,
): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'group-frame',
    position: { x: 0, y: 0 },
    data: {
      kind: 'group-frame',
      title: 'Locked group',
      description: 'Group',
      status: 'idle',
      locked,
      collapsed: false,
      color: '#667788',
      childNodeIds,
      purpose: 'workflow-stage',
      layout: 'freeform',
      autoFit: false,
    },
  };
}
