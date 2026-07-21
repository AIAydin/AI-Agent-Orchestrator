import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...arguments_: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    handle: vi.fn((channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => electronMock.handlers.delete(channel)),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
}));

import type { Project } from '../../shared/application/contracts.js';
import { AGENT_PEERS_IPC_CHANNELS } from '../../shared/agent-peers/index.js';
import type { LocalStore } from '../storage.js';
import type { ProviderPeerMaterial, WriteProviderPeerMaterialInput } from './provider-config.js';
import { AgentPeersIpcService } from './ipc.js';
import type { AgentPeersService } from './service.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const NODE_ID = 'agent-node-1';
const PROVISION_ID = '20000000-0000-4000-8000-000000000001';
const EDGE_ID = 'edge-1';

const project: Project = {
  id: PROJECT_ID,
  name: 'Fixture project',
  path: '/fake/project/root',
  openedAt: '2026-07-20T12:00:00.000Z',
  missing: false,
  health: { status: 'clean', detail: null },
} as unknown as Project;

const provisionInput = { projectId: PROJECT_ID, nodeId: NODE_ID, adapterId: 'claude' };

let userDataRoot: string;

beforeEach(async () => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
  userDataRoot = await mkdtemp(join(tmpdir(), 'agent-peers-ipc-test-'));
});

afterEach(async () => {
  await rm(userDataRoot, { recursive: true, force: true });
});

describe('AgentPeersIpcService provision', () => {
  it('resolves the project root, provisions the hub, writes provider material, registers cleanup, and returns the view', async () => {
    const fixture = createFixture();
    const { event } = liveEvent();

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, provisionInput);

    expect(fixture.store.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(fixture.service.provision).toHaveBeenCalledWith(PROJECT_ID, NODE_ID);
    expect(fixture.writeMaterial).toHaveBeenCalledWith({
      adapterId: 'claude',
      provisionDir: join(userDataRoot, 'agent-peers', PROVISION_ID),
      projectRoot: '/fake/project/root',
      environment: {
        FORGEBOARD_PEER_URL: 'http://127.0.0.1:54999',
        FORGEBOARD_PEER_TOKEN: 'test-secret-token',
      },
    });
    expect(fixture.service.registerCleanup).toHaveBeenCalledWith(
      PROVISION_ID,
      fixture.materialCleanup,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        provisionId: PROVISION_ID,
        available: true,
        hint: null,
        extraArguments: [
          '--mcp-config',
          join(userDataRoot, 'agent-peers', PROVISION_ID, 'mcp.json'),
        ],
      },
    });

    // The provision directory must exist before writeMaterial is ever invoked.
    const stats = await stat(join(userDataRoot, 'agent-peers', PROVISION_ID));
    expect(stats.isDirectory()).toBe(true);
  });

  it('never leaks the provision URL or token into the returned view', async () => {
    createFixture();
    const { event } = liveEvent();

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, provisionInput);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-secret-token');
    expect(serialized).not.toContain('127.0.0.1:54999');
  });

  it('fails without provisioning when the project is unavailable', async () => {
    const fixture = createFixture({ project: undefined });
    const { event } = liveEvent();

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, provisionInput);

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.service.provision).not.toHaveBeenCalled();
    expect(fixture.writeMaterial).not.toHaveBeenCalled();
  });

  it('fails without provisioning when the project is marked missing', async () => {
    const fixture = createFixture({ project: { ...project, missing: true } });
    const { event } = liveEvent();

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, provisionInput);

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.service.provision).not.toHaveBeenCalled();
  });

  it('defensively treats a null environment as empty rather than throwing', async () => {
    const fixture = createFixture({ environment: null });
    const { event } = liveEvent();

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, provisionInput);

    expect(fixture.writeMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ environment: {} }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects malformed input before touching the store or hub', async () => {
    const fixture = createFixture();
    const { event } = liveEvent();

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, {
      projectId: PROJECT_ID,
      nodeId: NODE_ID,
      // adapterId omitted -- schema requires min length 1.
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.store.getProject).not.toHaveBeenCalled();
    expect(fixture.service.provision).not.toHaveBeenCalled();
  });

  it('rejects requests from a non-live frame', async () => {
    const fixture = createFixture();
    const { event } = liveEvent();
    (event.sender as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, provisionInput);

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.service.provision).not.toHaveBeenCalled();
  });
});

describe('AgentPeersIpcService delivery events', () => {
  it('fans out onMessageDelivered events to every registered owner webContents', async () => {
    const fixture = createFixture();
    const { event: eventA, send: sendA } = liveEvent(1);
    const { event: eventB, send: sendB } = liveEvent(2);

    await handler(AGENT_PEERS_IPC_CHANNELS.provision)(eventA, provisionInput);
    await handler(AGENT_PEERS_IPC_CHANNELS.provision)(eventB, provisionInput);

    fixture.emitDelivered({ projectId: PROJECT_ID, edgeId: EDGE_ID });

    expect(sendA).toHaveBeenCalledWith(AGENT_PEERS_IPC_CHANNELS.event, {
      projectId: PROJECT_ID,
      edgeId: EDGE_ID,
    });
    expect(sendB).toHaveBeenCalledWith(AGENT_PEERS_IPC_CHANNELS.event, {
      projectId: PROJECT_ID,
      edgeId: EDGE_ID,
    });
  });

  it('stops delivering to a webContents once it is destroyed', async () => {
    const fixture = createFixture();
    const { event: eventA, send: sendA, once: onceA } = liveEvent(1);
    await handler(AGENT_PEERS_IPC_CHANNELS.provision)(eventA, provisionInput);

    const destroyedHandler = onceA.mock.calls.find(([name]) => name === 'destroyed')?.[1] as
      | (() => void)
      | undefined;
    expect(destroyedHandler).toBeDefined();
    destroyedHandler?.();

    fixture.emitDelivered({ projectId: PROJECT_ID, edgeId: EDGE_ID });

    expect(sendA).not.toHaveBeenCalled();
  });

  it('stops broadcasting after dispose', async () => {
    const fixture = createFixture();
    const { event: eventA, send: sendA } = liveEvent(1);
    await handler(AGENT_PEERS_IPC_CHANNELS.provision)(eventA, provisionInput);

    await fixture.ipc.dispose();
    fixture.emitDelivered({ projectId: PROJECT_ID, edgeId: EDGE_ID });

    expect(sendA).not.toHaveBeenCalled();
    expect(electronMock.removeHandler).toHaveBeenCalledWith(AGENT_PEERS_IPC_CHANNELS.provision);
  });
});

describe('AgentPeersIpcService lifecycle delegation', () => {
  it('delegates pauseForShutdown, pauseForDataMutation, resetForPrivacy, resumeAfterPrivacyReset, and dispose to the hub', async () => {
    const fixture = createFixture();

    await fixture.ipc.pauseForShutdown();
    expect(fixture.service.pauseForShutdown).toHaveBeenCalledTimes(1);

    const fixture2 = createFixture();
    await fixture2.ipc.pauseForDataMutation();
    expect(fixture2.service.pauseForDataMutation).toHaveBeenCalledTimes(1);

    const fixture3 = createFixture();
    await fixture3.ipc.resetForPrivacy();
    expect(fixture3.service.resetForPrivacy).toHaveBeenCalledTimes(1);
    fixture3.ipc.resumeAfterPrivacyReset();
    expect(fixture3.service.resumeAfterPrivacyReset).toHaveBeenCalledTimes(1);

    await fixture.ipc.dispose();
    expect(fixture.service.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects provision requests while paused', async () => {
    const fixture = createFixture();
    await fixture.ipc.pauseForShutdown();
    const { event } = liveEvent();

    const result = await handler(AGENT_PEERS_IPC_CHANNELS.provision)(event, provisionInput);

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.service.provision).not.toHaveBeenCalled();
  });
});

interface Fixture {
  readonly ipc: AgentPeersIpcService;
  readonly service: {
    provision: ReturnType<typeof vi.fn>;
    environmentForProvision: ReturnType<typeof vi.fn>;
    registerCleanup: ReturnType<typeof vi.fn>;
    onMessageDelivered: ReturnType<typeof vi.fn>;
    pauseForShutdown: ReturnType<typeof vi.fn>;
    pauseForDataMutation: ReturnType<typeof vi.fn>;
    resetForPrivacy: ReturnType<typeof vi.fn>;
    resumeAfterPrivacyReset: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  readonly store: { getProject: ReturnType<typeof vi.fn> };
  readonly writeMaterial: ReturnType<typeof vi.fn>;
  readonly materialCleanup: ReturnType<typeof vi.fn>;
  emitDelivered(event: { projectId: string; edgeId: string }): void;
}

function createFixture(
  options: {
    project?: Project | undefined;
    environment?: Record<string, string> | null;
  } = {},
): Fixture {
  const resolvedProject = 'project' in options ? options.project : project;
  const environment =
    options.environment === undefined
      ? {
          FORGEBOARD_PEER_URL: 'http://127.0.0.1:54999',
          FORGEBOARD_PEER_TOKEN: 'test-secret-token',
        }
      : options.environment;

  const listeners = new Set<(event: { projectId: string; edgeId: string }) => void>();
  const service = {
    provision: vi.fn(() =>
      Promise.resolve({
        provisionId: PROVISION_ID,
        url: 'http://127.0.0.1:54999',
      }),
    ),
    environmentForProvision: vi.fn(() => environment),
    registerCleanup: vi.fn(),
    onMessageDelivered: vi.fn(
      (listener: (event: { projectId: string; edgeId: string }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    ),
    pauseForShutdown: vi.fn().mockResolvedValue(undefined),
    pauseForDataMutation: vi.fn().mockResolvedValue(undefined),
    resetForPrivacy: vi.fn().mockResolvedValue(undefined),
    resumeAfterPrivacyReset: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  };

  const store = {
    getProject: vi.fn(() => resolvedProject),
  };

  const materialCleanup = vi.fn().mockResolvedValue(undefined);
  const writeMaterial = vi.fn(
    (input: WriteProviderPeerMaterialInput): Promise<ProviderPeerMaterial> =>
      Promise.resolve({
        available: true,
        hint: null,
        extraArguments: ['--mcp-config', join(input.provisionDir, 'mcp.json')],
        cleanup: materialCleanup,
      }),
  );

  const app: Pick<App, 'getPath'> = { getPath: () => userDataRoot };

  const ipc = new AgentPeersIpcService(
    app,
    service as unknown as AgentPeersService,
    store as unknown as Pick<LocalStore, 'getProject'>,
    writeMaterial,
  );
  ipc.registerIpcHandlers();

  return {
    ipc,
    service,
    store,
    writeMaterial,
    materialCleanup,
    emitDelivered: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function liveEvent(id = 7): {
  event: IpcMainInvokeEvent;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
} {
  const frame = {};
  const send = vi.fn();
  const once = vi.fn();
  const sender = {
    id,
    mainFrame: frame,
    isDestroyed: () => false,
    once,
    send,
  } as unknown as WebContents;
  return { event: { sender, senderFrame: frame } as IpcMainInvokeEvent, send, once };
}

function handler(channel: string) {
  const registered = electronMock.handlers.get(channel);
  if (registered === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return registered;
}
