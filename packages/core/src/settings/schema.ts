import { z } from 'zod';

import {
  CURRENT_SCHEMA_VERSION,
  CommandSpecSchema,
  EntityIdSchema,
  TimestampSchema,
} from '../model/domain.js';

export const ThemeSchema = z.enum(['light', 'dark', 'system']);

export const ApplicationSettingsSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    appearance: z
      .object({
        theme: ThemeSchema.default('system'),
        density: z.enum(['comfortable', 'compact']).default('comfortable'),
        motion: z.enum(['full', 'reduced', 'system']).default('system'),
      })
      .strict(),
    agents: z
      .object({
        defaultAdapterId: EntityIdSchema.optional(),
        defaultPermissionProfileId: EntityIdSchema,
        executableOverrides: z.record(z.string().min(1).max(4096)).default({}),
        environmentNameAllowlists: z
          .record(z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)))
          .default({}),
      })
      .strict(),
    git: z
      .object({
        writableRunsUseWorktrees: z.literal(true).default(true),
        defaultBaseBranch: z.string().min(1).max(1024).default('main'),
        cleanupPolicy: z.enum(['manual', 'after-merge', 'after-retention']).default('manual'),
        requireApprovalForExternalAndDestructiveActions: z.literal(true).default(true),
      })
      .strict(),
    commands: z
      .object({
        development: CommandSpecSchema.optional(),
        test: CommandSpecSchema.optional(),
        lint: CommandSpecSchema.optional(),
        typecheck: CommandSpecSchema.optional(),
        build: CommandSpecSchema.optional(),
        custom: z.record(CommandSpecSchema).default({}),
      })
      .strict(),
    docker: z
      .object({
        enabled: z.boolean().default(false),
        image: z.string().max(1024).default(''),
        containerExecutable: z.string().max(4096).default(''),
        network: z.enum(['enabled', 'disabled']).default('disabled'),
        cpuLimit: z.number().positive().max(1024).default(2),
        memoryMbLimit: z.number().int().min(128).max(1_048_576).default(4096),
        mountHostCredentials: z.literal(false).default(false),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.enabled && value.image.trim() === '') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['image'],
            message: 'Docker isolation requires an explicit image.',
          });
        }
        const executableSegments = value.containerExecutable.split('/').slice(1);
        const executableIsValid =
          value.containerExecutable.startsWith('/') &&
          !value.containerExecutable.includes('\0') &&
          !/[\r\n]/u.test(value.containerExecutable) &&
          executableSegments.length > 0 &&
          executableSegments.every(
            (segment) => segment !== '' && segment !== '.' && segment !== '..',
          );
        if (value.enabled && !executableIsValid) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['containerExecutable'],
            message: 'Docker isolation requires an absolute normalized agent executable.',
          });
        }
      }),
    preview: z
      .object({
        portRangeStart: z.number().int().min(1024).max(65_535).default(4100),
        portRangeEnd: z.number().int().min(1024).max(65_535).default(4199),
        openExternalRequiresApproval: z.literal(true).default(true),
      })
      .strict()
      .refine((value) => value.portRangeStart <= value.portRangeEnd, {
        message: 'Preview port range start must not exceed its end',
      }),
    storage: z
      .object({
        transcriptRetentionDays: z.number().int().min(1).max(3650).default(30),
        auditRetentionDays: z.number().int().min(1).max(3650).default(365),
        snapshotRetentionCount: z.number().int().min(1).max(10_000).default(100),
        autosaveIntervalMs: z.number().int().min(250).max(3_600_000).default(2000),
      })
      .strict(),
    collaboration: z
      .object({
        enabled: z.boolean().default(false),
        serverOrigin: z.string().url().optional(),
        reconnect: z.boolean().default(true),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.enabled && value.serverOrigin === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['serverOrigin'],
            message: 'Collaboration requires a server origin',
          });
        }
      }),
    updates: z
      .object({
        channel: z.enum(['stable', 'prerelease', 'disabled']).default('stable'),
        automaticDownload: z.boolean().default(false),
      })
      .strict(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ApplicationSettings = z.infer<typeof ApplicationSettingsSchema>;
