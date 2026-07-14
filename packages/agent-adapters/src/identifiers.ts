import { z } from 'zod';

export const AgentAdapterIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

/**
 * Adapter ids contributed by extensions must have at least two non-empty dot-separated
 * namespace segments. This browser-safe schema is shared by settings, IPC, and the runtime.
 */
export const NamespacedAgentAdapterIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/u);
