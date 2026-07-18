import { z } from 'zod';

import { MachineSpecificValueSchema } from '../settings/values.js';

export const DockerExecutableSettingSchema = MachineSpecificValueSchema;

export const DockerImageReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/u,
    'Container image names cannot contain spaces or special characters.',
  )
  .refine(
    (value) => !value.split('/').includes('..'),
    'Container image names cannot contain "..".',
  );

export const DockerContainerExecutableSchema = MachineSpecificValueSchema.pipe(
  z.string().max(4_096),
)
  .refine(
    (value) => value.startsWith('/'),
    'Enter the full path of the agent executable inside the image, starting with /.',
  )
  .refine((value) => {
    const segments = value.split('/').slice(1);
    return (
      segments.length > 0 &&
      segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    );
  }, 'Remove any "." or ".." parts from the agent executable path inside the image.');

export const DockerReadinessInputSchema = z
  .object({
    dockerExecutable: DockerExecutableSettingSchema,
    image: DockerImageReferenceSchema,
    containerExecutable: DockerContainerExecutableSchema,
  })
  .strict();
export type DockerReadinessInput = z.infer<typeof DockerReadinessInputSchema>;

export const DockerReadinessStatusSchema = z.enum([
  'ready',
  'executable-unavailable',
  'daemon-unavailable',
  'image-missing',
  'image-incompatible',
  'agent-unavailable',
]);
export type DockerReadinessStatus = z.infer<typeof DockerReadinessStatusSchema>;

export const DockerReadinessSchema = z
  .object({
    executable: z.string().min(1).max(32_768),
    image: DockerImageReferenceSchema,
    containerExecutable: DockerContainerExecutableSchema,
    executableAvailable: z.boolean(),
    daemonAvailable: z.boolean(),
    imageAvailable: z.boolean(),
    imageCompatible: z.boolean(),
    containerExecutableAvailable: z.boolean(),
    available: z.boolean(),
    status: DockerReadinessStatusSchema,
    checkedAt: z.string().datetime(),
    daemonVersion: z.string().max(256).optional(),
    imageId: z.string().max(512).optional(),
    agentVersion: z.string().max(2_048).optional(),
    reason: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type DockerReadiness = z.infer<typeof DockerReadinessSchema>;

export const DockerPullResultSchema = z
  .object({
    outcome: z.enum(['cancelled', 'pulled']),
    readiness: DockerReadinessSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.outcome === 'cancelled') !== (result.readiness === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readiness'],
        message: 'Cancelled pulls have no process-derived readiness; completed pulls require it.',
      });
    }
  });
export type DockerPullResult = z.infer<typeof DockerPullResultSchema>;
