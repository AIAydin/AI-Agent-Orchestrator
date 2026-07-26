import { describe, expect, it } from 'vitest';

import {
  MachineSpecificPathSchema,
  normalizePreviewLoopbackHost,
  PreviewTrustedHostsSchema,
} from './values.js';

describe('machine-specific settings values', () => {
  it('bounds folders and rejects blank or control-bearing paths', () => {
    expect(MachineSpecificPathSchema.safeParse('/tmp/forgeboard').success).toBe(true);
    expect(MachineSpecificPathSchema.safeParse('C:\\Artemis\\worktrees').success).toBe(true);
    expect(MachineSpecificPathSchema.safeParse('relative/worktrees').success).toBe(false);
    expect(MachineSpecificPathSchema.safeParse('   ').success).toBe(false);
    expect(MachineSpecificPathSchema.safeParse(' /tmp/forgeboard').success).toBe(false);
    expect(MachineSpecificPathSchema.safeParse('/tmp/forgeboard\nother').success).toBe(false);
    expect(MachineSpecificPathSchema.safeParse('/tmp/forgeboard\0other').success).toBe(false);
    expect(MachineSpecificPathSchema.safeParse('x'.repeat(32_769)).success).toBe(false);
  });
});

describe('preview loopback hosts', () => {
  it('normalizes supported loopback forms without accepting network hosts', () => {
    expect(normalizePreviewLoopbackHost('LOCALHOST.')).toBe('localhost');
    expect(normalizePreviewLoopbackHost('[::1]')).toBe('::1');
    expect(normalizePreviewLoopbackHost('127.42.0.7')).toBe('127.42.0.7');
    expect(normalizePreviewLoopbackHost('0.0.0.0')).toBeNull();
    expect(normalizePreviewLoopbackHost('192.168.1.5')).toBeNull();
    expect(normalizePreviewLoopbackHost('localhost:3000')).toBeNull();
    expect(normalizePreviewLoopbackHost(' localhost')).toBeNull();
  });

  it('bounds and de-duplicates the normalized allowlist', () => {
    expect(PreviewTrustedHostsSchema.safeParse(['localhost', '127.0.0.1', '::1']).success).toBe(
      true,
    );
    expect(PreviewTrustedHostsSchema.safeParse(['localhost', 'LOCALHOST.']).success).toBe(false);
    expect(PreviewTrustedHostsSchema.safeParse([]).success).toBe(false);
    expect(
      PreviewTrustedHostsSchema.safeParse(Array.from({ length: 129 }, () => 'localhost')).success,
    ).toBe(false);
  });
});
