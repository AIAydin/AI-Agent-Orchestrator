import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCustomCliAdapter, type PermissionProfile } from '@forgeboard/agent-adapters';
import {
  CanvasNodeSchema,
  CanvasSchema,
  createWorkflowExecutionRuntime,
  type Canvas,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';
import { RepositoryService } from '@forgeboard/git-engine';
import { describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  RunDisclosureSchema,
  type AppSettings,
  type Project,
} from '../../../shared/application/contracts.js';
import { legacySurfaceFromCanonical } from '../../../shared/canvas/adapter.js';
import type { AgentAdapterPlanner } from '../../agent-execution/contracts.js';
import { AgentExecutionRuntime } from '../../agent-execution/runtime.js';
import { LocalStore } from '../../storage.js';
import {
  createWorkflowRuntimeComposition,
  type WorkflowRuntimeComposition,
} from '../../workflow/host/composition.js';
import { FileNodeWorkflowContextResolver } from '../../workflow/host/context-resolver.js';
import type { WorkflowHost, WorkflowHostState } from '../../workflow/host/service.js';

const PROJECT_ID = '7a000000-0000-4000-8000-000000000001';
const CANVAS_ID = '7a000000-0000-4000-8000-000000000002';
const AGENT_NODE_ID = 'privacy-agent';
const FILE_NODE_ID = 'selected-file';
const CREATED_AT = '2026-07-15T21:00:00.000Z';
const ALLOWED_BYTES = 'ALLOWED_CONTEXT_SENTINEL\n';
const DOTENV_BYTES = 'FORGEBOARD_PRIVATE_TOKEN=must-not-reach-provider\n';
const GIT_IGNORED_BYTES = 'GIT_IGNORED_SENTINEL\n';
const FORGEBOARD_IGNORED_BYTES = 'FORGEBOARD_IGNORED_SENTINEL\n';
const OUTSIDE_BYTES = 'SYMLINK_AND_TRAVERSAL_SENTINEL\n';

interface RepositoryFixture {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly databasePath: string;
  readonly recorderScript: string;
  readonly spawnMarker: string;
  readonly providerCapture: string;
}

interface OpenApplication {
  readonly store: LocalStore;
  readonly runtime: AgentExecutionRuntime;
  readonly composition: WorkflowRuntimeComposition;
  readonly host: WorkflowHost;
  readonly plannerCalls: () => number;
}

interface NetworkTrap {
  readonly attempts: readonly string[];
  restore(): void;
}

describe('default solo privacy integration', () => {
  it('denies sensitive, ignored, symlink, and traversal context before backend planning or spawn', async () => {
    const fixture = await createRepositoryFixture();
    let application: OpenApplication | undefined;
    try {
      application = openApplication(fixture);
      const deniedCases: ReadonlyArray<
        readonly [name: string, relativePath: string, expectedReason: RegExp]
      > = [
        ['dotenv', '.env.production', /credentials/iu],
        ['git-ignore', 'ignored-by-git.txt', /ignored by \.gitignore/iu],
        ['forgeboard-ignore', 'ignored-by-forgeboard.txt', /ignored by \.forgeboardignore/iu],
        ['symlink-escape', 'linked-outside/secret.txt', /escapes through a symlink/iu],
      ];

      for (const [name, relativePath, expectedReason] of deniedCases) {
        const canvas = contextCanvas(name, relativePath);
        saveCanvas(application.store, canvas);
        const state = await application.host.start({
          projectId: PROJECT_ID,
          canvas,
          scope: {
            kind: 'node',
            nodeId: AGENT_NODE_ID,
            includeUpstream: false,
          },
        });
        expect(state.runtime.run.nodeRuns[AGENT_NODE_ID]).toMatchObject({
          status: 'failed',
          failureCode: 'EXECUTOR_PREPARATION_FAILED',
        });
        expect(state.runtime.run.nodeRuns[AGENT_NODE_ID]?.statusReason).toMatch(expectedReason);
        expect(state.approvals).toEqual([]);
      }

      const resolver = new FileNodeWorkflowContextResolver(application.store);
      const traversalRuntime = corruptedTraversalRuntime(
        contextCanvas('privacy-traversal', 'src/allowed.txt'),
      );
      await expect(
        resolver.resolve({
          executionId: 'privacy-traversal-execution',
          projectId: PROJECT_ID,
          nodeId: AGENT_NODE_ID,
          attempt: 1,
          attachmentIds: [FILE_NODE_ID],
          runtime: traversalRuntime,
        }),
      ).rejects.toThrow(/path|relative|travers/iu);

      expect(application.plannerCalls()).toBe(0);
      await expect(access(fixture.spawnMarker)).rejects.toThrow();
      await expect(access(fixture.providerCapture)).rejects.toThrow();

      const auditText = JSON.stringify(application.store.listAuditEvents(1_000));
      expect(auditText).not.toContain(DOTENV_BYTES.trim());
      expect(auditText).not.toContain(GIT_IGNORED_BYTES.trim());
      expect(auditText).not.toContain(FORGEBOARD_IGNORED_BYTES.trim());
      expect(auditText).not.toContain(OUTSIDE_BYTES.trim());
      expect(
        application.store
          .listAuditEvents(1_000)
          .filter((event) => event.category === 'workflow-context' && event.outcome === 'denied'),
      ).toHaveLength(deniedCases.length + 1);
    } finally {
      if (application !== undefined) await closeApplication(application);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('discloses logical context and sends only immutable approved bytes with zero network attempts', async () => {
    const fixture = await createRepositoryFixture();
    const network = installForgeboardNetworkTrap();
    let application: OpenApplication | undefined;
    try {
      application = openApplication(fixture);
      const canvas = contextCanvas('privacy-approved', 'src/allowed.txt');
      saveCanvas(application.store, canvas);

      const waiting = await application.host.start({
        projectId: PROJECT_ID,
        canvas,
        scope: { kind: 'node', nodeId: AGENT_NODE_ID, includeUpstream: false },
      });
      const approval = waiting.approvals[0];
      if (approval === undefined) throw new Error('Expected an exact agent launch approval.');
      const disclosure = RunDisclosureSchema.parse(approval.disclosure);
      const allowedPath = await realpath(path.join(fixture.repository, 'src', 'allowed.txt'));
      const allowedDigest = createHash('sha256').update(ALLOWED_BYTES).digest('hex');

      expect(disclosure).toMatchObject({
        nodeId: AGENT_NODE_ID,
        adapterId: 'test-agent',
        provider: 'Local deterministic context recorder',
        contextAttachments: [{ path: allowedPath, kind: 'file', sha256: allowedDigest }],
        permissionProfile: {
          mode: 'plan-read-only',
          network: 'provider-controlled',
        },
      });
      expect(disclosure.contextManifestId).toEqual(expect.any(String));
      expect(disclosure.contextManifestDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(disclosure.warnings).toContain(
        'This deterministic fixture stays local and opens no network connection.',
      );
      expect(application.plannerCalls()).toBe(1);
      await expect(access(fixture.spawnMarker)).rejects.toThrow();
      await expect(access(fixture.providerCapture)).rejects.toThrow();
      expect(network.attempts).toEqual([]);

      await application.host.approveNode({
        executionId: waiting.execution.id,
        nodeId: AGENT_NODE_ID,
        preparationId: approval.preparationId,
        approvalFingerprint: approval.approvalFingerprint,
        approvedBy: 'privacy-integration-test',
      });
      const completed = await waitForTerminal(application.host, waiting.execution.id);
      expect(completed.runtime.run.status).toBe('succeeded');
      expect(completed.runtime.run.nodeRuns[AGENT_NODE_ID]?.status).toBe('succeeded');
      await expect(readFile(fixture.spawnMarker, 'utf8')).resolves.toBe('spawned after approval\n');

      const captured = JSON.parse(await readFile(fixture.providerCapture, 'utf8')) as {
        readonly prompt: string;
        readonly attachments: ReadonlyArray<{
          readonly path: string;
          readonly content: string;
        }>;
      };
      expect(captured.attachments).toHaveLength(1);
      const capturedAttachment = captured.attachments[0];
      if (capturedAttachment === undefined) throw new Error('Expected one captured attachment.');
      expect(capturedAttachment.content).toBe(ALLOWED_BYTES);
      expect(path.isAbsolute(capturedAttachment.path)).toBe(true);
      expect(capturedAttachment.path).not.toBe(allowedPath);
      expect(captured.prompt).toContain('No other file is implicitly attached');
      expect(captured.prompt).toContain(`- file: ${capturedAttachment.path}`);
      expect(captured.prompt).not.toContain(allowedPath);
      await expect(access(capturedAttachment.path)).rejects.toThrow();
      expect(JSON.stringify(captured)).not.toContain('.env.production');
      expect(JSON.stringify(captured)).not.toContain('ignored-by-git.txt');
      expect(JSON.stringify(captured)).not.toContain('ignored-by-forgeboard.txt');
      expect(JSON.stringify(captured)).not.toContain(DOTENV_BYTES.trim());
      expect(JSON.stringify(captured)).not.toContain(GIT_IGNORED_BYTES.trim());
      expect(JSON.stringify(captured)).not.toContain(FORGEBOARD_IGNORED_BYTES.trim());
      expect(JSON.stringify(captured)).not.toContain(OUTSIDE_BYTES.trim());

      expect(network.attempts).toEqual([]);
      const audit = application.store.listAuditEvents(1_000);
      expect(audit.filter((event) => event.category === 'external-send')).toEqual([]);
      expect(
        audit.filter(
          (event) => event.category === 'workflow-context' && event.outcome === 'allowed',
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      if (application !== undefined) await closeApplication(application);
      network.restore();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function openApplication(fixture: RepositoryFixture): OpenApplication {
  const store = new LocalStore(fixture.databasePath);
  store.saveProject(project(fixture.repository));
  const repositories = new RepositoryService();
  let planCount = 0;
  const planner = contextRecorderPlanner(fixture, () => {
    planCount += 1;
  });
  const runtime = new AgentExecutionRuntime({
    store,
    getSettings: () => settings(fixture.managedRoot),
    emit: () => undefined,
    repositories,
    planAdapter: planner,
    resolveTestAgentCliPath: () => Promise.resolve(fixture.recorderScript),
  });
  const composition = createWorkflowRuntimeComposition({
    store,
    runs: { executionOperations: () => runtime },
    repositories,
    getSettings: () => settings(fixture.managedRoot),
  });
  return {
    store,
    runtime,
    composition,
    host: composition.createHost(() => undefined),
    plannerCalls: () => planCount,
  };
}

async function closeApplication(application: OpenApplication): Promise<void> {
  const outcomes = await Promise.allSettled([
    application.host.dispose(),
    application.composition.dispose(),
  ]);
  await application.runtime.dispose();
  application.store.close();
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (failure !== undefined) throw failure.reason;
}

function contextRecorderPlanner(
  fixture: RepositoryFixture,
  observePlan: () => void,
): AgentAdapterPlanner {
  const adapter = createCustomCliAdapter({
    schemaVersion: 1,
    id: 'test-agent',
    name: 'Local deterministic context recorder',
    provider: {
      name: 'Local deterministic context recorder',
      sendsContextOffDevice: false,
      disclosure: 'This deterministic fixture stays local and opens no network connection.',
    },
    executable: {
      command: process.execPath,
      versionArguments: ['--version'],
      versionPattern: '(?<version>\\d+(?:\\.\\d+)+)',
    },
    invocation: {
      runtime: 'pipes',
      launchArguments: ['{permissionArgs}', '{extraArgs}', '{prompt}'],
      promptTransport: 'argument',
      modelArguments: [],
      context: { strategy: 'prompt-references' },
      permissionArguments: { 'plan-read-only': [] },
      output: 'text',
    },
    capabilities: {
      interactiveInput: false,
      interrupt: true,
      terminate: true,
      resume: false,
      ansiStreaming: false,
      structuredOutput: false,
      modelSelection: false,
      contextAttachments: true,
      permissionModes: ['plan-read-only'],
    },
    suggestedEnvironmentVariables: [],
  });
  return (input, cwd) => {
    observePlan();
    return Promise.resolve({
      adapter,
      plan: adapter.prepareLaunch({
        prompt: input.prompt,
        cwd,
        permissionProfile: contextRecorderPermission(cwd),
        contextAttachments: input.context.attachments,
        executable: process.execPath,
        extraArguments: [fixture.recorderScript, fixture.providerCapture, fixture.spawnMarker],
        environment: { inherit: 'none', variables: {}, unset: [] },
      }),
      detectionWarnings: [],
      trustedExtensionAdapter: false,
    });
  };
}

function contextRecorderPermission(cwd: string): PermissionProfile {
  return {
    id: 'privacy-integration-plan',
    name: 'Local deterministic read-only context recorder',
    mode: 'plan-read-only',
    enforcement: 'provider',
    readRoots: [cwd],
    writeRoots: [],
    network: 'provider-controlled',
    approvalPolicy: 'The exact context manifest and child process require approval before launch.',
    disclosure:
      'Forgeboard controls the selected context; a third-party provider process would control its own network behavior.',
  };
}

function contextCanvas(name: string, relativePath: string): Canvas {
  const agent = CanvasNodeSchema.parse({
    ...nodeBase(AGENT_NODE_ID, 'Privacy verification agent'),
    type: 'agent',
    data: {
      adapterId: 'test-agent',
      permissionProfileId: 'plan-read-only',
      promptDraft: 'Inspect only the selected context.',
      contextAttachmentIds: [FILE_NODE_ID],
    },
  });
  const file = CanvasNodeSchema.parse({
    ...nodeBase(FILE_NODE_ID, 'Explicit context file'),
    type: 'file',
    data: {
      file: {
        projectId: PROJECT_ID,
        relativePath,
        kind: 'file',
        missing: false,
      },
    },
  });
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: `Privacy context ${name}`,
    nodes: [agent, file],
    edges: [],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function saveCanvas(store: LocalStore, canvas: Canvas): void {
  const surface = legacySurfaceFromCanonical(canvas);
  store.saveCanvas({
    ...surface,
    nodes: [...surface.nodes],
    edges: [...surface.edges],
    canonical: canvas,
  });
}

function corruptedTraversalRuntime(canvas: Canvas): WorkflowExecutionRuntime {
  const runtime = createWorkflowExecutionRuntime(canvas, {
    planId: 'privacy-traversal-plan',
    runId: 'privacy-traversal-execution',
    scope: { kind: 'node', nodeId: AGENT_NODE_ID, includeUpstream: false },
    occurredAt: CREATED_AT,
    eligibleNodeIds: [AGENT_NODE_ID],
  });
  const corrupted = structuredClone(runtime) as WorkflowExecutionRuntime & {
    canvas: { nodes: Array<Record<string, unknown>> };
  };
  const file = corrupted.canvas.nodes.find((node) => node['id'] === FILE_NODE_ID);
  if (file === undefined) throw new Error('Traversal fixture lost its File node.');
  const data = file['data'] as { file: { relativePath: string } };
  data.file.relativePath = '../outside/secret.txt';
  return corrupted;
}

function nodeBase(id: string, title: string) {
  return {
    id,
    title,
    color: '#445566',
    icon: 'shield',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

async function waitForTerminal(
  host: WorkflowHost,
  executionId: string,
): Promise<WorkflowHostState> {
  let state = await host.getState(executionId);
  for (let attempt = 0; attempt < 300 && state.runtime.run.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = await host.getState(executionId);
  }
  if (state.runtime.run.status === 'running') {
    throw new Error('Timed out waiting for the deterministic context recorder.');
  }
  return state;
}

async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forgeboard-solo-privacy-')));
  const repository = path.join(root, 'repository');
  const managedRoot = path.join(root, 'managed-worktrees');
  const outside = path.join(root, 'outside');
  const state = path.join(root, 'state');
  await Promise.all([
    mkdir(path.join(repository, 'src'), { recursive: true }),
    mkdir(managedRoot),
    mkdir(outside),
    mkdir(state),
  ]);
  await Promise.all([
    writeFile(path.join(repository, 'src', 'allowed.txt'), ALLOWED_BYTES),
    writeFile(path.join(repository, '.env.production'), DOTENV_BYTES),
    writeFile(path.join(repository, 'ignored-by-git.txt'), GIT_IGNORED_BYTES),
    writeFile(path.join(repository, 'ignored-by-forgeboard.txt'), FORGEBOARD_IGNORED_BYTES),
    writeFile(path.join(repository, '.gitignore'), 'ignored-by-git.txt\n'),
    writeFile(path.join(repository, '.forgeboardignore'), 'ignored-by-forgeboard.txt\n'),
    writeFile(path.join(outside, 'secret.txt'), OUTSIDE_BYTES),
  ]);
  await symlink(
    outside,
    path.join(repository, 'linked-outside'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(path.join(state, 'context-recorder.cjs'), recorderSource());
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Forgeboard Privacy Test']);
  await runGit(repository, ['config', 'user.email', 'privacy@example.invalid']);
  await runGit(repository, ['add', '--', 'src/allowed.txt', '.gitignore', '.forgeboardignore']);
  await runGit(repository, ['commit', '-m', 'Initial privacy fixture']);
  return {
    root,
    repository: await realpath(repository),
    managedRoot: await realpath(managedRoot),
    databasePath: path.join(state, 'forgeboard.sqlite3'),
    recorderScript: path.join(state, 'context-recorder.cjs'),
    spawnMarker: path.join(state, 'provider-spawned.txt'),
    providerCapture: path.join(state, 'provider-capture.json'),
  };
}

function recorderSource(): string {
  return [
    "'use strict';",
    "const { readFileSync, writeFileSync } = require('node:fs');",
    'const [capturePath, markerPath, prompt] = process.argv.slice(2);',
    "writeFileSync(markerPath, 'spawned after approval\\n');",
    'const paths = [...prompt.matchAll(/^- file: (.+)$/gmu)].map((match) => match[1]);',
    'const attachments = paths.map((selectedPath) => ({',
    '  path: selectedPath,',
    "  content: readFileSync(selectedPath, 'utf8'),",
    '}));',
    'writeFileSync(capturePath, `${JSON.stringify({ prompt, attachments }, null, 2)}\\n`);',
    "process.stdout.write('approved context captured\\n');",
    '',
  ].join('\n');
}

function settings(managedRoot: string): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'plan-read-only',
    worktreeRoot: managedRoot,
    branchPrefix: 'forgeboard/',
    gitRemote: 'origin',
    terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    envAllowlist: [],
    previewPortStart: 45_000,
    previewPortEnd: 45_100,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
    updateChannel: 'disabled',
  });
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Default solo privacy fixture',
    path: repository,
    openedAt: CREATED_AT,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: true,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: ['Environment file detected and excluded from automatic context.'],
    },
  };
}

function installForgeboardNetworkTrap(): NetworkTrap {
  const attempts: string[] = [];
  const restore: Array<() => void> = [];
  const require = createRequire(import.meta.url);
  const modules = [
    ['node:http', ['request', 'get']],
    ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']],
    ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ] as const;
  for (const [moduleName, methods] of modules) {
    const module = require(moduleName) as object;
    for (const method of methods)
      blockCallable(module, method, `${moduleName}.${method}`, attempts, restore);
  }
  const netModule = require('node:net') as { Socket: { prototype: object } };
  const dgramModule = require('node:dgram') as {
    Socket: { prototype: object };
  };
  blockCallable(
    netModule.Socket.prototype,
    'connect',
    'node:net.Socket.connect',
    attempts,
    restore,
  );
  blockCallable(dgramModule.Socket.prototype, 'send', 'node:dgram.Socket.send', attempts, restore);
  blockCallable(globalThis, 'fetch', 'global fetch', attempts, restore);
  blockCallable(globalThis, 'WebSocket', 'global WebSocket', attempts, restore);
  syncBuiltinESMExports();

  return {
    attempts,
    restore: () => {
      for (const restoreOne of restore.reverse()) restoreOne();
      syncBuiltinESMExports();
    },
  };
}

function blockCallable(
  target: object,
  property: PropertyKey,
  label: string,
  attempts: string[],
  restore: Array<() => void>,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor === undefined || typeof descriptor.value !== 'function') return;
  Object.defineProperty(target, property, {
    ...descriptor,
    value: function blockedForgeboardNetworkCall(): never {
      attempts.push(label);
      throw new Error(`Unexpected Forgeboard-owned network attempt through ${label}.`);
    },
  });
  restore.push(() => Object.defineProperty(target, property, descriptor));
}

function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...arguments_],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
          GIT_WORK_TREE: undefined,
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else
          reject(
            new Error(`git ${arguments_.join(' ')} failed: ${stderr}`, {
              cause: error,
            }),
          );
      },
    );
  });
}
