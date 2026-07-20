import { EntityIdSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

/**
 * IPC surface for the agent-peers hub (Task 6): a renderer provisions a peer channel for one
 * agent-session node's launch, then listens for delivery events so the canvas can reflect
 * peer-to-peer message activity. No URL/token ever crosses this boundary — see
 * `AgentPeersProvisionViewSchema`.
 */
export const AGENT_PEERS_IPC_CHANNELS = Object.freeze({
  provision: 'agent-peers:provision',
  event: 'agent-peers:event',
} as const);

export const AgentPeersProjectIdSchema = z.string().uuid();
export const AgentPeersNodeIdSchema = EntityIdSchema;
export const AgentPeersEdgeIdSchema = EntityIdSchema;
export const AgentPeersAdapterIdSchema = z.string().min(1).max(100);

export const AgentPeersProvisionInputSchema = z
  .object({
    projectId: AgentPeersProjectIdSchema,
    nodeId: AgentPeersNodeIdSchema,
    adapterId: AgentPeersAdapterIdSchema,
  })
  .strict();
export type AgentPeersProvisionInput = z.infer<typeof AgentPeersProvisionInputSchema>;

/**
 * Never carries the hub's URL/token: those stay main-process-only (see
 * `AgentPeersService.environmentForProvision`) and are injected straight into the spawned
 * process's environment by `TerminalService`, never returned over IPC.
 */
export const AgentPeersProvisionViewSchema = z
  .object({
    provisionId: z.string().uuid(),
    available: z.boolean(),
    hint: z.string().nullable(),
    extraArguments: z.array(z.string()).max(64),
  })
  .strict();
export type AgentPeersProvisionView = z.infer<typeof AgentPeersProvisionViewSchema>;

export const AgentPeersEventSchema = z
  .object({
    projectId: AgentPeersProjectIdSchema,
    edgeId: AgentPeersEdgeIdSchema,
  })
  .strict();
export type AgentPeersEvent = z.infer<typeof AgentPeersEventSchema>;
