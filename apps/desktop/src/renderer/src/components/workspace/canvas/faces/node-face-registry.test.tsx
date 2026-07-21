// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { nodeFaceForKind } from './node-face-registry.js';

describe('nodeFaceForKind', () => {
  it('returns face components for kinds that render content on the node', () => {
    expect(nodeFaceForKind('agent')).toBeTypeOf('function');
    expect(nodeFaceForKind('web-preview')).toBeTypeOf('function');
    expect(nodeFaceForKind('mobile-preview')).toBeTypeOf('function');
    expect(nodeFaceForKind('brief')).toBeTypeOf('function');
    expect(nodeFaceForKind('diagram')).toBeTypeOf('function');
    expect(nodeFaceForKind('file')).toBeTypeOf('function');
    expect(nodeFaceForKind('git-pr')).toBeTypeOf('function');
    expect(nodeFaceForKind('note-image')).toBeTypeOf('function');
    expect(nodeFaceForKind('review-gate')).toBeTypeOf('function');
    expect(nodeFaceForKind('task')).toBeTypeOf('function');
    expect(nodeFaceForKind('test')).toBeTypeOf('function');
    expect(nodeFaceForKind('whiteboard')).toBeTypeOf('function');
  });

  it('returns null for kinds that keep the generic node body', () => {
    expect(nodeFaceForKind('group-frame')).toBeNull();
    expect(nodeFaceForKind('extension')).toBeNull();
    expect(nodeFaceForKind('unknown-kind')).toBeNull();
  });
});
