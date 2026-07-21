import { describe, expect, it } from 'vitest';

import { VOICE_MAX_SAMPLES } from '../../../../../shared/voice/contracts.js';
import { joinVoiceChunks, resampleVoiceAudio } from './audio.js';

describe('voice audio preparation', () => {
  it('joins chunks and resamples to 16 kHz', () => {
    const joined = joinVoiceChunks([new Float32Array([0, 0.5]), new Float32Array([-0.5, 0])]);
    expect([...joined]).toEqual([0, 0.5, -0.5, 0]);
    expect(resampleVoiceAudio(new Float32Array(48_000), 48_000)).toHaveLength(16_000);
  });

  it('caps prepared audio at the IPC recording limit', () => {
    expect(resampleVoiceAudio(new Float32Array(VOICE_MAX_SAMPLES * 3), 48_000)).toHaveLength(
      VOICE_MAX_SAMPLES,
    );
  });
});
