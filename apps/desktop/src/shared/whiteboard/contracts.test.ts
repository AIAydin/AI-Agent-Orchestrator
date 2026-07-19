import { describe, expect, it } from 'vitest';

import { WhiteboardSvgExportInputSchema, WhiteboardSvgExportResultSchema } from './contracts.js';

describe('whiteboard export contracts', () => {
  it('normalizes a bounded ordinary SVG image file name', () => {
    expect(
      WhiteboardSvgExportInputSchema.parse({ fileName: 'Checkout mockup', svg: '<svg />' })
        .fileName,
    ).toBe('Checkout mockup.svg');
  });

  it.each(['../escape', '/absolute', '.hidden', 'bad:name', ''])(
    'rejects unsafe file name %j',
    (fileName) => {
      expect(WhiteboardSvgExportInputSchema.safeParse({ fileName, svg: '<svg />' }).success).toBe(
        false,
      );
    },
  );

  it('bounds SVG input and native result basenames', () => {
    expect(
      WhiteboardSvgExportInputSchema.safeParse({
        fileName: 'board.svg',
        svg: 'x'.repeat(2_000_001),
      }).success,
    ).toBe(false);
    expect(WhiteboardSvgExportResultSchema.safeParse({ fileName: '../board.svg' }).success).toBe(
      false,
    );
  });
});
