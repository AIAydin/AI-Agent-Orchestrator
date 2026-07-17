import { z } from 'zod';

import {
  GitConnectionSha256Schema,
  GitConnectionTimestampSchema,
  GitConnectionUuidSchema,
} from './common.js';

export const GITHUB_CLI_MAX_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;

export const GitHubCliSourceSchema = z.enum(['automatic', 'custom']);
export type GitHubCliSource = z.infer<typeof GitHubCliSourceSchema>;

const GitHubCliFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      ![...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      }),
    'GitHub CLI filenames must be path-free.',
  );

const GitHubCliVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      }),
    'GitHub CLI versions must be bounded single-line text.',
  );

export const GitHubCliIdentityViewSchema = z
  .object({
    source: GitHubCliSourceSchema,
    filename: GitHubCliFileNameSchema,
    sizeBytes: z.number().int().nonnegative().max(GITHUB_CLI_MAX_EXECUTABLE_BYTES),
    sha256: GitConnectionSha256Schema,
    version: GitHubCliVersionSchema.nullable(),
  })
  .strict();
export type GitHubCliIdentityView = z.infer<typeof GitHubCliIdentityViewSchema>;

export const GitHubCliSelectionPlanViewSchema = z
  .object({
    kind: z.literal('github-cli-selection'),
    planId: GitConnectionUuidSchema,
    expiresAt: GitConnectionTimestampSchema,
    source: GitHubCliSourceSchema,
    candidate: GitHubCliIdentityViewSchema.nullable(),
    networkAccess: z.literal(false),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.source === 'custom' && plan.candidate === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate'],
        message: 'A custom GitHub CLI selection must expose its safe executable identity.',
      });
    }
    if (plan.candidate !== null && plan.candidate.source !== plan.source) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate', 'source'],
        message: 'GitHub CLI candidate source must match the planned selection source.',
      });
    }
    if (plan.candidate !== null && plan.candidate.version !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate', 'version'],
        message: 'GitHub CLI selection plans cannot claim a version before confirmation.',
      });
    }
  });
export type GitHubCliSelectionPlanView = z.infer<typeof GitHubCliSelectionPlanViewSchema>;

export const GitHubCliStatusStateSchema = z.enum(['unavailable', 'unverified', 'ready', 'changed']);
export type GitHubCliStatusState = z.infer<typeof GitHubCliStatusStateSchema>;

export const GitHubCliStatusViewSchema = z
  .object({
    source: GitHubCliSourceSchema,
    state: GitHubCliStatusStateSchema,
    identity: GitHubCliIdentityViewSchema.nullable(),
    verifiedAt: GitConnectionTimestampSchema.nullable(),
    checkedAt: GitConnectionTimestampSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (status.identity !== null && status.identity.source !== status.source) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity', 'source'],
        message: 'GitHub CLI identity source must match its active configuration.',
      });
    }
    if (status.state === 'unavailable' && status.identity !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity'],
        message: 'An unavailable GitHub CLI cannot expose a current executable identity.',
      });
    }
    if (status.state !== 'unavailable' && status.identity === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity'],
        message: 'A discovered GitHub CLI must expose its safe executable identity.',
      });
    }
    const currentlyVerified = status.state === 'ready';
    if (currentlyVerified !== (status.verifiedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifiedAt'],
        message: 'Only a ready GitHub CLI can expose a current verification time.',
      });
    }
    if (currentlyVerified && status.identity?.version === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity', 'version'],
        message: 'A ready GitHub CLI must expose its verified version.',
      });
    }
    if (status.state === 'unverified' && status.identity?.version !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity', 'version'],
        message: 'An unverified GitHub CLI cannot expose a verified version.',
      });
    }
  });
export type GitHubCliStatusView = z.infer<typeof GitHubCliStatusViewSchema>;
