import { z } from 'zod';

export const DIAGRAM_IPC_CHANNELS = {
  exportSvg: 'diagram:export-svg',
} as const;

const DiagramFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/u)
  .transform((value) => (value.toLowerCase().endsWith('.svg') ? value : `${value}.svg`));

const ExportedDiagramFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\]+$/u)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && code !== 127;
      }),
    'Exported diagram file names cannot contain control characters.',
  );

export const DiagramSvgExportInputSchema = z
  .object({
    fileName: DiagramFileNameSchema,
    svg: z.string().min(1).max(2_000_000),
  })
  .strict();
export type DiagramSvgExportInput = z.infer<typeof DiagramSvgExportInputSchema>;

export const DiagramSvgExportResultSchema = z
  .object({ fileName: ExportedDiagramFileNameSchema })
  .strict()
  .nullable();
export type DiagramSvgExportResult = z.infer<typeof DiagramSvgExportResultSchema>;
