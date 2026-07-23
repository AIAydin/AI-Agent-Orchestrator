import { z } from 'zod';

const TerminalAgentAdapterIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value), {
    message: 'The terminal Agent adapter ID is invalid.',
  });

const TerminalManagedBranchSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value), {
    message: 'The managed worktree branch is invalid.',
  });

/**
 * Path-free renderer request for the root that a terminal launch should use. Ordinary Terminal
 * nodes omit this field and remain rooted in the selected project. Agent nodes may request a
 * managed worktree, but Electron main resolves and authorizes the real path.
 */
export const TerminalWorkspaceRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z
    .object({
      kind: z.literal('managed-agent-worktree'),
      adapterId: TerminalAgentAdapterIdSchema,
    })
    .strict(),
]);
export type TerminalWorkspaceRequest = z.infer<typeof TerminalWorkspaceRequestSchema>;

/** Path-free durable workspace identity returned after a managed Agent session starts. */
export const TerminalWorkspaceViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z
    .object({
      kind: z.literal('managed-agent-worktree'),
      runId: z.string().uuid(),
      branch: TerminalManagedBranchSchema,
    })
    .strict(),
]);
export type TerminalWorkspaceView = z.infer<typeof TerminalWorkspaceViewSchema>;

export function effectiveTerminalWorkspaceRequest(
  request: TerminalWorkspaceRequest | undefined,
): TerminalWorkspaceRequest {
  return request ?? { kind: 'project' };
}
