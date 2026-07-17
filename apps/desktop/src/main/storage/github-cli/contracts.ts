import { basename } from 'node:path';

import { z } from 'zod';

import { MachineSpecificPathSchema } from '../../../shared/settings/values.js';

export const GITHUB_CLI_MAX_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;

const SafeFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !containsControlCharacter(value),
    { message: 'GitHub CLI file names must be safe path-free names.' },
  );

const GitHubCliVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u, 'GitHub CLI version evidence is invalid.');

const SafeIdentityIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SafeIdentityTimeSchema = z
  .number()
  .finite()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const GitHubCliExecutableIdentitySchema = z
  .object({
    dev: SafeIdentityIntegerSchema,
    ino: SafeIdentityIntegerSchema,
    size: SafeIdentityIntegerSchema.max(GITHUB_CLI_MAX_EXECUTABLE_BYTES),
    mtimeMs: SafeIdentityTimeSchema,
    ctimeMs: SafeIdentityTimeSchema,
    mode: SafeIdentityIntegerSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type GitHubCliExecutableIdentity = z.infer<typeof GitHubCliExecutableIdentitySchema>;

/** Device-local evidence for one explicitly selected and version-validated GitHub CLI binary. */
export const StoredGitHubCliBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    executablePath: MachineSpecificPathSchema,
    executableFileName: SafeFileNameSchema,
    executableIdentity: GitHubCliExecutableIdentitySchema,
    version: GitHubCliVersionSchema,
    validatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (!pathsEqual(binding.executableFileName, basename(binding.executablePath))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executableFileName'],
        message: 'GitHub CLI file name must match its canonical executable path.',
      });
    }
  });
export type StoredGitHubCliBinding = z.infer<typeof StoredGitHubCliBindingSchema>;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
