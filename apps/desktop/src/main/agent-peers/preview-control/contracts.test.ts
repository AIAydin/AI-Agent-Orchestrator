import { describe, expect, it } from 'vitest';

import { parseActionRequest, parseNavigateRequest, parseScrollRequest } from './contracts.js';

const HANDLE = '11111111-1111-4111-8111-111111111111';

describe('agent preview action requests', () => {
  it('accepts only page-bound click and bounded text actions', () => {
    expect(
      parseActionRequest({
        previewId: 'preview-1',
        action: { kind: 'click', elementHandle: HANDLE },
      }),
    ).toEqual({
      previewId: 'preview-1',
      action: { kind: 'click', elementHandle: HANDLE },
    });
    expect(
      parseActionRequest({
        previewId: 'preview-1',
        action: { kind: 'navigate', url: 'https://example.com' },
      }),
    ).toBeNull();
    expect(
      parseActionRequest({
        previewId: 'preview-1',
        action: {
          kind: 'type',
          elementHandle: HANDLE,
          text: 'x'.repeat(4_001),
          replace: true,
        },
      }),
    ).toBeNull();
  });

  it('bounds navigate requests', () => {
    expect(
      parseNavigateRequest({ previewId: 'preview-1', url: 'http://localhost:5173/settings' }),
    ).toEqual({ previewId: 'preview-1', url: 'http://localhost:5173/settings' });
    expect(parseNavigateRequest({ previewId: 'preview-1', url: '' })).toBeNull();
    expect(parseNavigateRequest({ previewId: 'preview-1', url: 'x'.repeat(2_049) })).toBeNull();
    expect(parseNavigateRequest({ previewId: '', url: 'http://localhost:5173/' })).toBeNull();
    expect(parseNavigateRequest({ url: 'http://localhost:5173/' })).toBeNull();
  });

  it('bounds scroll requests and rejects coordinates or oversized movement', () => {
    expect(parseScrollRequest({ previewId: 'preview-1', deltaY: 600 })).toEqual({
      previewId: 'preview-1',
      deltaY: 600,
    });
    expect(parseScrollRequest({ previewId: 'preview-1', deltaY: 1_201 })).toBeNull();
    expect(parseScrollRequest({ previewId: 'preview-1', x: 20, y: 30 })).toBeNull();
  });
});
