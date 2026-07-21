// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { nodeFaceForKind } from './node-face-registry.js';

describe('nodeFaceForKind', () => {
  it('returns face components for kinds that render content on the node', () => {
    expect(nodeFaceForKind('agent')).toBeTypeOf('function');
    expect(nodeFaceForKind('web-preview')).toBeTypeOf('function');
    expect(nodeFaceForKind('mobile-preview')).toBeTypeOf('function');
    expect(nodeFaceForKind('git-pr')).toBeTypeOf('function');
    expect(nodeFaceForKind('whiteboard')).toBeTypeOf('function');
  });

  it('returns null for kinds that keep the generic node body', () => {
    expect(nodeFaceForKind('group-frame')).toBeNull();
    expect(nodeFaceForKind('file')).toBeNull();
    expect(nodeFaceForKind('extension')).toBeNull();
    expect(nodeFaceForKind('unknown-kind')).toBeNull();
  });
});
