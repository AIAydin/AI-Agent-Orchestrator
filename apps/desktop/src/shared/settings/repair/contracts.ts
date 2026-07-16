import { z } from 'zod';

export const SETTINGS_REPAIR_HISTORY_LIMIT = 20;
// Preserve substantially oversized legacy values without allowing one corrupt row to amplify into
// unbounded JSON, hashing, IPC, and renderer allocations during recovery.
export const SETTINGS_REPAIR_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;

export function settingsRepairEvidenceFitsByteLimit(value: string): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      // TextEncoder and Node's UTF-8 encoders replace isolated surrogates with U+FFFD.
      bytes += 3;
    }
    if (bytes > SETTINGS_REPAIR_EVIDENCE_MAX_BYTES) return false;
  }
  return true;
}

const SettingsRepairJsonEvidenceSchema = z
  .string()
  .min(2)
  .max(SETTINGS_REPAIR_EVIDENCE_MAX_BYTES)
  .refine(settingsRepairEvidenceFitsByteLimit, {
    message: 'Settings repair evidence exceeds the 16 MiB UTF-8 limit.',
  });

export const SettingsRepairFieldPathSchema = z.enum([
  'agentExecutableOverrides',
  'customAgent',
  'defaultAgent',
  'customPermissionProfile',
  'defaultPermissionProfile',
  'worktreeRoot',
  'terminalShell',
  'developmentCommand',
  'testCommand',
  'lintCommand',
  'typecheckCommand',
  'buildCommand',
  'customChecks',
  'previewTrustedHosts',
  'dockerExecutable',
  'dockerContainerExecutable',
  'dockerEnabled',
  'backupDirectory',
  'backupsEnabled',
]);
export type SettingsRepairFieldPath = z.infer<typeof SettingsRepairFieldPathSchema>;

const SettingsRepairSummaryFields = {
  id: z.string().uuid(),
  repairedAt: z.string().datetime(),
  sourceDatabaseVersion: z.number().int().nonnegative().max(10_000),
  repairedFieldPaths: z
    .array(SettingsRepairFieldPathSchema)
    .min(1)
    .max(SettingsRepairFieldPathSchema.options.length)
    .refine((paths) => new Set(paths).size === paths.length, {
      message: 'Settings repair field paths must be unique.',
    }),
  sourceSettingsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  repairedSettingsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
} as const;

export const SettingsRepairSummarySchema = z.object(SettingsRepairSummaryFields).strict();
export type SettingsRepairSummary = z.infer<typeof SettingsRepairSummarySchema>;

export const SettingsRepairEvidenceSchema = z
  .object({
    ...SettingsRepairSummaryFields,
    sourceSettingsJson: SettingsRepairJsonEvidenceSchema,
    repairedSettingsJson: SettingsRepairJsonEvidenceSchema,
  })
  .strict();
export type SettingsRepairEvidence = z.infer<typeof SettingsRepairEvidenceSchema>;

export const SettingsRepairEvidenceExportSchema = z
  .object({
    format: z.literal('forgeboard-settings-repair-evidence'),
    version: z.literal(1),
    repair: SettingsRepairEvidenceSchema,
  })
  .strict();
export type SettingsRepairEvidenceExport = z.infer<typeof SettingsRepairEvidenceExportSchema>;
