import { describe, expect, it } from 'vitest';

import {
  PreviewSurfaceBoundsSchema,
  PreviewSurfaceCreateInputSchema,
  PreviewSurfaceEventSchema,
} from './contracts.js';

describe('preview surface contracts', () => {
  it('accepts strict loopback-ready create payloads', () => {
    expect(
      PreviewSurfaceCreateInputSchema.parse({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        nodeId: 'preview-1',
        url: 'http://127.0.0.1:41000/',
        bounds: { x: 0, y: 80, width: 640, height: 480, visible: true },
        touchEmulation: true,
      }),
    ).toMatchObject({ nodeId: 'preview-1' });
  });

  it('rejects unknown fields and unbounded geometry', () => {
    expect(() =>
      PreviewSurfaceBoundsSchema.parse({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        visible: true,
      }),
    ).toThrow();
    expect(() =>
      PreviewSurfaceCreateInputSchema.parse({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        nodeId: 'preview-1',
        url: 'http://127.0.0.1:41000/',
        bounds: { x: 0, y: 0, width: 640, height: 480, visible: true },
        touchEmulation: false,
        preload: '/tmp/escape.js',
      }),
    ).toThrow();
  });

  it('bounds event payloads through the shared schema', () => {
    expect(() =>
      PreviewSurfaceEventSchema.parse({
        type: 'console',
        surfaceId: 'not-a-capability',
      }),
    ).toThrow();
  });
});
