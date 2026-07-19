import { z } from 'zod';

export const WHITEBOARD_IPC_CHANNELS = {
  exportSvg: 'whiteboard:export-svg',
} as const;

const WhiteboardFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/u)
  .transform((value) => (value.toLowerCase().endsWith('.svg') ? value : `${value}.svg`));

const ExportedWhiteboardFileNameSchema = z
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
    'Exported whiteboard file names cannot contain control characters.',
  );

export const WhiteboardSvgExportInputSchema = z
  .object({
    fileName: WhiteboardFileNameSchema,
    svg: z.string().min(1).max(2_000_000),
  })
  .strict();
export type WhiteboardSvgExportInput = z.infer<typeof WhiteboardSvgExportInputSchema>;

export const WhiteboardSvgExportResultSchema = z
  .object({ fileName: ExportedWhiteboardFileNameSchema })
  .strict()
  .nullable();
export type WhiteboardSvgExportResult = z.infer<typeof WhiteboardSvgExportResultSchema>;
