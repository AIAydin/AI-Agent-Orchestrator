import { z } from 'zod';

export const UPDATE_IPC_CHANNELS = Object.freeze({
  check: 'updates:check',
  cancel: 'updates:cancel',
  openRelease: 'updates:open-release',
});

export const UpdateChannelSchema = z.enum(['stable', 'prerelease', 'disabled']);
const SemanticVersionSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );

export const UpdateCheckInputSchema = z
  .object({ channel: UpdateChannelSchema })
  .strict()
  .refine((input) => input.channel !== 'disabled', 'Update checks are disabled.');
export type UpdateCheckInput = z.infer<typeof UpdateCheckInputSchema>;

export const UpdateReleaseSchema = z
  .object({
    id: z.number().int().positive(),
    version: SemanticVersionSchema,
    tagName: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    url: z.string().url().max(2_048),
    publishedAt: z.string().datetime(),
    prerelease: z.boolean(),
  })
  .strict()
  .superRefine((release, context) => {
    const url = new URL(release.url);
    const expectedPath = `/AIAydin/AI-Agent-Orchestrator/releases/tag/${encodeURIComponent(release.tagName)}`;
    if (
      url.origin !== 'https://github.com' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== expectedPath
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Use the exact official Forgeboard release URL.',
      });
    }
    if (release.tagName !== `v${release.version}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tagName'],
        message: 'The tag must exactly bind the release version.',
      });
    }
    if (
      (release.version.split('+', 1)[0] ?? release.version).includes('-') &&
      !release.prerelease
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prerelease'],
        message: 'A prerelease version must be marked as prerelease metadata.',
      });
    }
  });
export type UpdateRelease = z.infer<typeof UpdateReleaseSchema>;

export const UpdateCheckResultSchema = z
  .object({
    channel: z.enum(['stable', 'prerelease']),
    currentVersion: SemanticVersionSchema,
    checkedAt: z.string().datetime(),
    status: z.enum(['up-to-date', 'update-available', 'no-release']),
    release: UpdateReleaseSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === 'no-release') !== (value.release === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['release'],
        message: 'Release state is inconsistent.',
      });
    }
    if (value.release !== null) {
      if (value.channel === 'stable' && value.release.prerelease) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['release', 'prerelease'],
          message: 'Stable checks cannot return prerelease releases.',
        });
      }
      const available = compareUpdateVersions(value.release.version, value.currentVersion) > 0;
      if ((value.status === 'update-available') !== available) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'Update status does not match the compared versions.',
        });
      }
    }
  });
export type UpdateCheckResult = z.infer<typeof UpdateCheckResultSchema>;

export const UpdateCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type UpdateCancelResult = z.infer<typeof UpdateCancelResultSchema>;

export const UpdateOpenReleaseInputSchema = z
  .object({ releaseId: z.number().int().positive() })
  .strict();

export function compareUpdateVersions(left: string, right: string): number {
  const parse = (value: string): [bigint[], string[]] => {
    const parsed = SemanticVersionSchema.parse(value);
    const precedence = parsed.split('+', 1)[0] ?? parsed;
    const separator = precedence.indexOf('-');
    const core = separator === -1 ? precedence : precedence.slice(0, separator);
    const prerelease = separator === -1 ? [] : precedence.slice(separator + 1).split('.');
    return [core.split('.').map((part) => BigInt(part)), prerelease];
  };
  const [leftCore, leftPre] = parse(left);
  const [rightCore, rightPre] = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftCore[index] !== rightCore[index])
      return (leftCore[index] ?? 0n) > (rightCore[index] ?? 0n) ? 1 : -1;
  }
  if (leftPre.length === 0 || rightPre.length === 0)
    return leftPre.length === rightPre.length ? 0 : leftPre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? BigInt(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? BigInt(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
