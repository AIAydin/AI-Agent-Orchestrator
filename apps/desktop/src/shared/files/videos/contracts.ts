import { z } from 'zod';

import { CanonicalFilePathSchema, ProjectFileIdSchema } from '../contracts.js';

export const PROJECT_VIDEO_SCHEME = 'forgeboard-video';
export const PROJECT_VIDEO_TOKEN_TTL_MS = 4 * 60 * 60 * 1_000;

export const ProjectVideoReferenceSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    kind: z.literal('file'),
    missing: z.boolean(),
  })
  .strict();
export type ProjectVideoReference = z.infer<typeof ProjectVideoReferenceSchema>;

export const ProjectVideoInputSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
  })
  .strict();
export type ProjectVideoInput = z.infer<typeof ProjectVideoInputSchema>;

export const ProjectVideoChooseInputSchema = z.object({ projectId: ProjectFileIdSchema }).strict();
export type ProjectVideoChooseInput = z.infer<typeof ProjectVideoChooseInputSchema>;

const ProjectVideoUnavailableSchema = z
  .object({
    status: z.enum(['missing', 'unavailable']),
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    message: z.string().min(1).max(1_000),
  })
  .strict();

const ProjectVideoAvailableSchema = z
  .object({
    status: z.literal('available'),
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    playbackUrl: z.string().regex(/^forgeboard-video:\/\/media\/[0-9a-f-]{36}$/u),
    mimeType: z.enum(['video/mp4', 'video/webm', 'video/ogg']),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const ProjectVideoLoadResultSchema = z.discriminatedUnion('status', [
  ProjectVideoAvailableSchema,
  ProjectVideoUnavailableSchema,
]);
export type ProjectVideoLoadResult = z.infer<typeof ProjectVideoLoadResultSchema>;

export const PROJECT_VIDEO_IPC_CHANNELS = Object.freeze({
  choose: 'files:videos:choose',
  load: 'files:videos:load',
});
