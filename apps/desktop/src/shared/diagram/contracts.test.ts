import { describe, expect, it } from 'vitest';

import { DiagramSvgExportInputSchema, DiagramSvgExportResultSchema } from './contracts.js';

describe('diagram export contracts', () => {
  it('normalizes a bounded ordinary SVG file name', () => {
    expect(
      DiagramSvgExportInputSchema.parse({
        fileName: 'System map',
        svg: '<svg />',
      }).fileName,
    ).toBe('System map.svg');
  });

  it.each(['../escape', '/absolute', '.hidden', 'bad:name', ''])(
    'rejects unsafe file name %j',
    (fileName) => {
      expect(DiagramSvgExportInputSchema.safeParse({ fileName, svg: '<svg />' }).success).toBe(
        false,
      );
    },
  );

  it('rejects oversized SVG input', () => {
    expect(
      DiagramSvgExportInputSchema.safeParse({
        fileName: 'diagram.svg',
        svg: 'x'.repeat(2_000_001),
      }).success,
    ).toBe(false);
  });

  it('preserves an ordinary user-renamed native export basename exactly', () => {
    expect(
      DiagramSvgExportResultSchema.parse({ fileName: 'Architecture – draft (final)' }),
    ).toEqual({ fileName: 'Architecture – draft (final)' });
  });
});
