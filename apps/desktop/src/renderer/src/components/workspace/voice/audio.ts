import { VOICE_MAX_SAMPLES, VOICE_SAMPLE_RATE } from '../../../../../shared/voice/contracts.js';

export function resampleVoiceAudio(input: Float32Array, sourceRate: number): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new Error('Invalid microphone rate.');
  if (input.length === 0) return input;
  if (sourceRate === VOICE_SAMPLE_RATE) return input.slice(0, VOICE_MAX_SAMPLES);
  const outputLength = Math.min(
    VOICE_MAX_SAMPLES,
    Math.floor((input.length * VOICE_SAMPLE_RATE) / sourceRate),
  );
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / VOICE_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const amount = position - left;
    output[index] = (input[left] ?? 0) * (1 - amount) + (input[right] ?? 0) * amount;
  }
  return output;
}

export function joinVoiceChunks(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
