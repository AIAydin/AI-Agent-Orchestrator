import { z } from 'zod';

import { CanonicalFilePathSchema, ProjectFileIdSchema } from '../contracts.js';

export const PROJECT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export const ProjectImageReferenceSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    kind: z.literal('image'),
    missing: z.boolean(),
    lastKnownHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type ProjectImageReference = z.infer<typeof ProjectImageReferenceSchema>;

export const ProjectImageChooseInputSchema = z
  .object({
    projectId: ProjectFileIdSchema,
  })
  .strict();
export type ProjectImageChooseInput = z.infer<typeof ProjectImageChooseInputSchema>;

export const ProjectImageLoadInputSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
  })
  .strict();
export type ProjectImageLoadInput = z.infer<typeof ProjectImageLoadInputSchema>;

const ProjectImageUnavailableSchema = z
  .object({
    status: z.enum(['missing', 'unavailable']),
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    message: z.string().min(1).max(1_000),
  })
  .strict();

const ProjectImageAvailableSchema = z
  .object({
    status: z.literal('available'),
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    dataUrl: z.string().max(Math.ceil((PROJECT_IMAGE_MAX_BYTES * 4) / 3) + 128),
  })
  .strict();

export const ProjectImageLoadResultSchema = z
  .discriminatedUnion('status', [ProjectImageAvailableSchema, ProjectImageUnavailableSchema])
  .superRefine((value, context) => {
    if (value.status === 'available' && !isValidatedInlineImage(value.dataUrl)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Image previews must contain bounded signature-valid inline image data',
      });
    }
  });
export type ProjectImageLoadResult = z.infer<typeof ProjectImageLoadResultSchema>;

export const PROJECT_IMAGE_IPC_CHANNELS = Object.freeze({
  choose: 'files:images:choose',
  load: 'files:images:load',
});

function isValidatedInlineImage(value: string): boolean {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (match === null) return false;
  const mimeType = match[1];
  const base64 = match[2] ?? '';
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const byteLength = (base64.length * 3) / 4 - padding;
  if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > PROJECT_IMAGE_MAX_BYTES) {
    return false;
  }
  try {
    const prefix = atob(base64.slice(0, 16));
    const byte = (index: number): number => prefix.codePointAt(index) ?? -1;
    if (mimeType === 'image/png') {
      return [137, 80, 78, 71, 13, 10, 26, 10].every((expected, index) => byte(index) === expected);
    }
    if (mimeType === 'image/jpeg') return byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff;
    if (mimeType === 'image/gif') return prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a');
    return prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP';
  } catch {
    return false;
  }
}
