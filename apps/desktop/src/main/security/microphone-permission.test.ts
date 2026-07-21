import { describe, expect, it } from 'vitest';

import { allowsForgeboardMicrophone } from './microphone-permission.js';

describe('microphone permission policy', () => {
  it('allows audio only for the opted-in main Forgeboard window', () => {
    expect(
      allowsForgeboardMicrophone({
        permission: 'media',
        isMainWindow: true,
        voiceCommandsEnabled: true,
        details: { mediaTypes: ['audio'] },
        requireAudioDetail: true,
      }),
    ).toBe(true);
  });

  it('denies video, guest windows, disabled voice, and unrelated permissions', () => {
    const base = {
      permission: 'media',
      isMainWindow: true,
      voiceCommandsEnabled: true,
      details: { mediaTypes: ['audio'] },
      requireAudioDetail: true,
    } as const;
    expect(
      allowsForgeboardMicrophone({ ...base, details: { mediaTypes: ['audio', 'video'] } }),
    ).toBe(false);
    expect(allowsForgeboardMicrophone({ ...base, isMainWindow: false })).toBe(false);
    expect(allowsForgeboardMicrophone({ ...base, voiceCommandsEnabled: false })).toBe(false);
    expect(allowsForgeboardMicrophone({ ...base, permission: 'notifications' })).toBe(false);
  });
});
