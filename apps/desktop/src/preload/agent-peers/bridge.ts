import type { ForgeboardApi } from '../../shared/api.js';
import {
  AGENT_PEERS_IPC_CHANNELS,
  AgentPeersEventSchema,
  AgentPeersProvisionInputSchema,
  AgentPeersProvisionViewSchema,
} from '../../shared/agent-peers/index.js';
import { ipcResultSchema } from '../../shared/application/contracts.js';

export type AgentPeersIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;
export type AgentPeersIpcSubscriber = (
  channel: string,
  listener: (payload: unknown) => void,
) => () => void;

/** Creates the renderer-facing bridge for provisioning agent-peer channels and observing
 * delivery events. Never exposes the hub's URL/token -- see `AgentPeersProvisionViewSchema`. */
export function createAgentPeersApi(
  invoke: AgentPeersIpcInvoker,
  subscribe: AgentPeersIpcSubscriber,
): ForgeboardApi['agentPeers'] {
  return {
    provision: async (input) => {
      const parsedInput = AgentPeersProvisionInputSchema.parse(input);
      const rawResult: unknown = await invoke(AGENT_PEERS_IPC_CHANNELS.provision, parsedInput);
      return ipcResultSchema(AgentPeersProvisionViewSchema).parse(rawResult);
    },
    onEvent: (listener) =>
      subscribe(AGENT_PEERS_IPC_CHANNELS.event, (payload) => {
        const event = AgentPeersEventSchema.safeParse(payload);
        if (event.success) listener(event.data);
      }),
  };
}
