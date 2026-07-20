import { describe, expect, it } from 'vitest';

import { isPreviewWebviewPartition, previewWebviewPartition } from './webview-partition.js';

describe('previewWebviewPartition', () => {
  it('builds non-persistent per-node partitions, with optional comparison slots', () => {
    expect(previewWebviewPartition('p1', 'n1')).toBe('preview:p1:n1');
    expect(previewWebviewPartition('p1', 'n1', 'comparison-left')).toBe(
      'preview:p1:n1:comparison-left',
    );
  });

  it('escapes separator characters inside ids', () => {
    expect(previewWebviewPartition('a:b', 'c:d')).toBe('preview:a%3Ab:c%3Ad');
    expect(isPreviewWebviewPartition(previewWebviewPartition('a:b', 'c:d'))).toBe(true);
  });
});

describe('isPreviewWebviewPartition', () => {
  it('accepts only the preview partition shape', () => {
    expect(isPreviewWebviewPartition('preview:p1:n1')).toBe(true);
    expect(isPreviewWebviewPartition('preview:p1:n1:comparison-right')).toBe(true);
    expect(isPreviewWebviewPartition('persist:preview:p1:n1')).toBe(false);
    expect(isPreviewWebviewPartition('preview:p1')).toBe(false);
    expect(isPreviewWebviewPartition('other:p1:n1')).toBe(false);
    expect(isPreviewWebviewPartition(undefined)).toBe(false);
  });
});
