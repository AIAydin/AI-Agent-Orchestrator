import { describe, expect, it, vi } from 'vitest';

import { AGENT_PEERS_IPC_CHANNELS } from '../../shared/agent-peers/index.js';
import { createAgentPeersApi } from './bridge.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const NODE_ID = 'agent-node-1';
const EDGE_ID = 'edge-1';
const PROVISION_ID = '20000000-0000-4000-8000-000000000001';

describe('agent-peers preload bridge', () => {
  it('validates the provision input and response before returning', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { provisionId: PROVISION_ID, available: true, hint: null, extraArguments: [] },
    });
    const api = createAgentPeersApi(invoke, () => vi.fn());

    await expect(
      api.provision({ projectId: PROJECT_ID, nodeId: NODE_ID, adapterId: 'claude' }),
    ).resolves.toEqual({
      ok: true,
      value: { provisionId: PROVISION_ID, available: true, hint: null, extraArguments: [] },
    });
    expect(invoke).toHaveBeenCalledWith(AGENT_PEERS_IPC_CHANNELS.provision, {
      projectId: PROJECT_ID,
      nodeId: NODE_ID,
      adapterId: 'claude',
    });
  });

  it('rejects a malformed provision input before ever invoking the channel', async () => {
    const invoke = vi.fn();
    const api = createAgentPeersApi(invoke, () => vi.fn());

    await expect(
      api.provision({ projectId: 'not-a-uuid', nodeId: NODE_ID, adapterId: 'claude' } as never),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a response that fails schema validation, e.g. a leaked token field', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        provisionId: PROVISION_ID,
        available: true,
        hint: null,
        extraArguments: [],
        token: 'should-never-be-here',
      },
    });
    const api = createAgentPeersApi(invoke, () => vi.fn());

    await expect(
      api.provision({ projectId: PROJECT_ID, nodeId: NODE_ID, adapterId: 'claude' }),
    ).rejects.toBeTruthy();
  });

  it('delivers only schema-valid events and forwards the channel/unsubscribe', () => {
    let eventHandler: ((payload: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((channel: string, listener: (payload: unknown) => void) => {
      expect(channel).toBe(AGENT_PEERS_IPC_CHANNELS.event);
      eventHandler = listener;
      return unsubscribe;
    });
    const api = createAgentPeersApi(vi.fn(), subscribe);
    const listener = vi.fn();

    const cleanup = api.onEvent(listener);
    eventHandler?.({ projectId: PROJECT_ID, edgeId: EDGE_ID });
    eventHandler?.({ projectId: 'not-a-uuid', edgeId: EDGE_ID });
    cleanup();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ projectId: PROJECT_ID, edgeId: EDGE_ID });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
