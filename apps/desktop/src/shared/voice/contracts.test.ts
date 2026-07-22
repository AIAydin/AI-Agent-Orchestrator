import { describe, expect, it } from 'vitest';

import {
  VOICE_MAX_SAMPLES,
  VoiceTranscriptionInputSchema,
  VoiceTranscriptionSchema,
} from './contracts.js';

describe('voice contracts', () => {
  it('accepts bounded normalized PCM and rejects oversized or invalid audio', () => {
    expect(
      VoiceTranscriptionInputSchema.safeParse({
        samples: new Float32Array(4_000),
      }).success,
    ).toBe(true);
    expect(
      VoiceTranscriptionInputSchema.safeParse({
        samples: new Float32Array(VOICE_MAX_SAMPLES + 1),
      }).success,
    ).toBe(false);
    expect(
      VoiceTranscriptionInputSchema.safeParse({
        samples: new Float32Array([0, Number.NaN]),
      }).success,
    ).toBe(false);
  });

  it('requires a non-empty bounded transcript', () => {
    expect(
      VoiceTranscriptionSchema.safeParse({
        text: 'create an agent',
        durationMs: 42,
      }).success,
    ).toBe(true);
    expect(VoiceTranscriptionSchema.safeParse({ text: '   ', durationMs: 42 }).success).toBe(false);
  });
});
