import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollaborationConnection,
  CollaborationEvent,
  CollaborationJoinInput,
} from '../../shared/collaboration/index.js';
import { OutboundActionGate } from '../outbound/outbound-action-gate.js';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
        electron.handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  },
}));

import { COLLABORATION_IPC_CHANNELS } from '../../shared/collaboration/index.js';
import { CollaborationIpcService, collaborationJoinDisclosure } from './ipc.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';

beforeEach(() => {
  electron.handlers.clear();
  electron.fromWebContents.mockReset();
});

describe('CollaborationIpcService ownership and approval', () => {
  it('discloses allowlisted free text without claiming to inspect or redact secrets', () => {
    const disclosure = collaborationJoinDisclosure(joinInput('SESSION_TOKEN_DO_NOT_DISCLOSE'));

    expect(disclosure.warning).toMatch(/only the allowlisted fields/u);
    expect(disclosure.warning).toMatch(/does not inspect or redact secrets/u);
    expect(disclosure.warning).toMatch(/not selected automatically/u);
    expect(disclosure.warning).not.toMatch(/are excluded/u);
    expect(JSON.stringify(disclosure)).not.toContain('SESSION_TOKEN_DO_NOT_DISCLOSE');
  });

  it('does not claim an owner on cancellation and never discloses the token', async () => {
    const client = fakeClient();
    const audit = { appendAudit: vi.fn() };
    const dialog = {
      showMessageBox: vi
        .fn()
        .mockResolvedValueOnce({ response: 0 })
        .mockResolvedValueOnce({ response: 1 }),
    };
    const service = new CollaborationIpcService(dialog, new OutboundActionGate(audit), { client });
    service.registerIpcHandlers();
    const first = renderer(1);
    const second = renderer(2);
    electron.fromWebContents.mockImplementation((sender) =>
      sender === first.sender ? first.parent : second.parent,
    );
    const token = 'SESSION_TOKEN_DO_NOT_DISCLOSE';

    await expect(invoke('join', first.event, joinInput(token))).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    await expect(invoke('join', second.event, joinInput(token))).resolves.toMatchObject({
      ok: true,
      connection: { status: 'connected' },
    });

    expect(client.join).toHaveBeenCalledOnce();
    expect(JSON.stringify(dialog.showMessageBox.mock.calls)).not.toContain(token);
    expect(JSON.stringify(audit.appendAudit.mock.calls)).not.toContain(token);
  });

  it('fails closed for another owner and clears ownership on leave', async () => {
    const client = fakeClient();
    const dialog = {
      showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
    };
    const service = new CollaborationIpcService(
      dialog,
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client },
    );
    service.registerIpcHandlers();
    const first = renderer(1);
    const second = renderer(2);
    electron.fromWebContents.mockImplementation((sender) =>
      sender === first.sender ? first.parent : second.parent,
    );

    await invoke('join', first.event, joinInput('first-token'));
    await expect(invoke('join', second.event, joinInput('second-token'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization-failed' },
    });
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(client.leave).not.toHaveBeenCalled();

    await expect(invoke('leave', first.event)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(client.leave).toHaveBeenCalledOnce();
    await expect(invoke('join', second.event, joinInput('second-token'))).resolves.toMatchObject({
      ok: true,
      connection: { subject: 'editor-1' },
    });
  });
});

function invoke(operation: 'join' | 'leave', event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(COLLABORATION_IPC_CHANNELS[operation]);
  if (handler === undefined) throw new Error(`Missing ${operation} handler.`);
  return handler(event, ...args);
}

function renderer(id: number) {
  const frame = { detached: false };
  const sender = {
    id,
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    send: vi.fn(),
  };
  return {
    sender,
    event: { sender, senderFrame: frame },
    parent: { isDestroyed: vi.fn(() => false) },
  };
}

function joinInput(accessToken: string): CollaborationJoinInput {
  return {
    serverUrl: 'wss://collaboration.example.test/team',
    roomId: 'launch-room',
    subject: 'editor-1',
    displayName: 'Local editor',
    color: '#6d5efc',
    accessToken,
    reconnect: true,
  };
}

function fakeClient() {
  let connection: CollaborationConnection | null = null;
  const listeners = new Set<(event: CollaborationEvent) => void>();
  return {
    get connection() {
      return connection;
    },
    join: vi.fn((input: CollaborationJoinInput) => {
      connection = {
        connectionId: CONNECTION_ID,
        serverUrl: input.serverUrl,
        roomId: input.roomId,
        subject: input.subject,
        displayName: input.displayName,
        color: input.color,
        role: 'editor',
        status: 'connected',
        reconnect: input.reconnect,
        reconnectAttempt: 0,
        connectedAt: NOW,
        lastTransitionAt: NOW,
      };
      return Promise.resolve({ ok: true as const, connection });
    }),
    leave: vi.fn(() => {
      connection = null;
      return null;
    }),
    publish: vi.fn(() => true),
    updateAwareness: vi.fn(() => true),
    onEvent: vi.fn((listener: (event: CollaborationEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
}
