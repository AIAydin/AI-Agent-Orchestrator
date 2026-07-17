import { z } from 'zod';

export const PREVIEW_TARGET_IPC_CHANNELS = Object.freeze({
  list: 'previews:list-targets',
});

const PreviewArgumentSchema = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'), {
    message: 'Preview arguments cannot contain NUL bytes.',
  });

/** Opaque renderer-safe identity. Main-process code resolves the actual checkout root. */
export const PreviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primary') }).strict(),
  z
    .object({
      kind: z.literal('agent-run'),
      runId: z.string().uuid(),
    })
    .strict(),
]);
export type PreviewTarget = z.infer<typeof PreviewTargetSchema>;

/** Literal command configuration. It is still resolved and natively reviewed by main. */
export const PreviewCommandSchema = z
  .object({
    executable: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0'), {
        message: 'The preview executable cannot contain NUL bytes.',
      }),
    args: z.array(PreviewArgumentSchema).max(512),
  })
  .strict();
export type PreviewCommand = z.infer<typeof PreviewCommandSchema>;

export const PreviewTargetListInputSchema = z.object({ projectId: z.string().uuid() }).strict();
export type PreviewTargetListInput = z.infer<typeof PreviewTargetListInputSchema>;

export const PreviewTargetViewSchema = z
  .object({
    target: PreviewTargetSchema,
    label: z.string().min(1).max(300),
    badge: z.enum(['Primary checkout', 'Agent worktree']),
    available: z.boolean(),
    unavailableReason: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((view, context) => {
    if (view.available === (view.unavailableReason !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unavailable preview targets require one reason; available targets have none.',
        path: ['unavailableReason'],
      });
    }
  });
export type PreviewTargetView = z.infer<typeof PreviewTargetViewSchema>;

export const PreviewTargetListSchema = z.array(PreviewTargetViewSchema).max(201);

export function previewTargetKey(target: PreviewTarget): string {
  return target.kind === 'primary' ? 'primary' : `agent-run:${target.runId}`;
}
