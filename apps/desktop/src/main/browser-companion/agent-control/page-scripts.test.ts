import { describe, expect, it } from 'vitest';

import {
  parsePageElementBounds,
  parsePageElementDescriptor,
  sameElementDescriptor,
} from './page-scripts.js';

const SAFE_BUTTON = {
  connected: true,
  kind: 'button',
  name: 'Add card',
  disabled: false,
  editable: false,
  sensitive: false,
  consequential: false,
  userOnly: false,
  opensNewWindow: false,
  destination: null,
} as const;

describe('browser companion agent page contracts', () => {
  it('accepts a bounded element descriptor and detects page mutations', () => {
    const descriptor = parsePageElementDescriptor(SAFE_BUTTON);
    expect(descriptor).toEqual(SAFE_BUTTON);
    expect(descriptor && sameElementDescriptor(descriptor, { ...descriptor })).toBe(true);
    expect(
      descriptor &&
        sameElementDescriptor(descriptor, {
          ...descriptor,
          name: 'Delete board',
        }),
    ).toBe(false);
  });

  it('rejects malformed descriptors and non-finite bounds', () => {
    expect(parsePageElementDescriptor({ ...SAFE_BUTTON, sensitive: 'no' })).toBeNull();
    expect(
      parsePageElementBounds({
        connected: true,
        hitMatches: true,
        x: 1,
        y: 2,
        width: 100,
        height: 30,
      }),
    ).toEqual({
      connected: true,
      hitMatches: true,
      x: 1,
      y: 2,
      width: 100,
      height: 30,
    });
    expect(
      parsePageElementBounds({
        connected: true,
        hitMatches: true,
        x: Number.NaN,
        y: 2,
        width: 100,
        height: 30,
      }),
    ).toBeNull();
  });
});
