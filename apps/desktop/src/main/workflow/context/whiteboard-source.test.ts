import { describe, expect, it } from 'vitest';

import { safeWhiteboardDocument } from './whiteboard-source.js';

function documentOf(...elements: unknown[]) {
  return safeWhiteboardDocument({ elements });
}

describe('safeWhiteboardDocument freehand strokes', () => {
  it('normalizes a stroke and keeps its points', () => {
    const safe = documentOf({
      id: 'f1',
      type: 'freedraw',
      x: 10,
      y: 20,
      width: 40,
      height: 50,
      points: [
        [0, 0],
        [40, 50],
      ],
    });
    expect(safe.elements[0]).toMatchObject({
      id: 'f1',
      type: 'freedraw',
      x: 10,
      y: 20,
      points: [
        [0, 0],
        [40, 50],
      ],
    });
  });

  it('truncates an oversized stroke and reports how many points were dropped', () => {
    const points = Array.from({ length: 600 }, (_, index) => [index, index]);
    const safe = documentOf({ id: 'f2', type: 'freedraw', points });
    expect(safe.elements[0]?.points).toHaveLength(512);
    expect(safe.truncatedPointCount).toBe(88);
  });

  it('drops a stroke left with fewer than two valid points', () => {
    const safe = documentOf({ id: 'f3', type: 'freedraw', points: [[0, 0]] });
    expect(safe.elements).toEqual([]);
    expect(safe.discardedElementCount).toBe(1);
  });

  it('reports no truncation for an ordinary document', () => {
    expect(documentOf({ id: 'r1', type: 'rectangle' }).truncatedPointCount).toBe(0);
  });
});

describe('safeWhiteboardDocument arrows', () => {
  it('preserves a stored direction', () => {
    const safe = documentOf({
      id: 'a1',
      type: 'arrow',
      width: 50,
      height: 50,
      points: [
        [50, 50],
        [0, 0],
      ],
    });
    expect(safe.elements[0]?.points).toEqual([
      [50, 50],
      [0, 0],
    ]);
  });

  it('falls back to the box diagonal for a legacy arrow', () => {
    const safe = documentOf({ id: 'a2', type: 'arrow', width: 100, height: 50 });
    expect(safe.elements[0]?.points).toEqual([
      [0, 0],
      [100, 50],
    ]);
  });
});

describe('safeWhiteboardDocument disclosure guarantees', () => {
  it('never reports embedded files as included', () => {
    expect(documentOf().embeddedFilesIncluded).toBe(false);
  });

  it('discards unsupported element types', () => {
    const safe = documentOf({ id: 'i1', type: 'image', fileId: 'secret' });
    expect(safe.elements).toEqual([]);
    expect(safe.discardedElementCount).toBe(1);
  });

  it('omits opaque fields rather than copying them into agent context', () => {
    const safe = documentOf({ id: 'r2', type: 'rectangle', link: 'https://example.com', customData: { a: 1 } });
    expect(safe.elements[0]).not.toHaveProperty('link');
    expect(safe.elements[0]).not.toHaveProperty('customData');
  });

  it('truncates text and counts elements beyond the cap', () => {
    const many = Array.from({ length: 1_010 }, (_, index) => ({ id: `n${String(index)}`, type: 'rectangle' }));
    const safe = safeWhiteboardDocument({ elements: many });
    expect(safe.elements).toHaveLength(1_000);
    expect(safe.truncatedElementCount).toBe(10);
  });

  it('clamps text length', () => {
    const safe = documentOf({ id: 't1', type: 'text', text: 'x'.repeat(5_000) });
    expect(safe.elements[0]?.text).toHaveLength(2_048);
  });
});
