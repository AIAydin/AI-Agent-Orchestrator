import { describe, expect, it } from 'vitest';

import { normalizeRotation, snappedRotation } from './text-rotation.js';

describe('text rotation helpers', () => {
  it('normalizes angles into [-180, 180]', () => {
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-190)).toBe(170);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(45)).toBe(45);
  });

  it('snaps to 15 degree steps while shift is held', () => {
    expect(snappedRotation(22, true)).toBe(15);
    expect(snappedRotation(23, true)).toBe(30);
  });

  it('snaps near cardinal angles without shift', () => {
    expect(snappedRotation(2, false)).toBe(0);
    expect(snappedRotation(88, false)).toBe(90);
    expect(snappedRotation(-178.5, false)).toBe(-180);
    expect(snappedRotation(40, false)).toBe(40);
  });
});
