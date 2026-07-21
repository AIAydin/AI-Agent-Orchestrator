import { z } from 'zod';

export const VOICE_MODEL_ID = 'onnx-community/whisper-tiny.en' as const;
export const VOICE_MODEL_REVISION = '2575352d61be1bf7225cf8f8b268a4678025fc58' as const;
export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_MAX_SECONDS = 30;
export const VOICE_MAX_SAMPLES = VOICE_SAMPLE_RATE * VOICE_MAX_SECONDS;

export const VoiceModelStatusSchema = z
  .object({
    state: z.enum(['not-installed', 'installing', 'ready', 'loading', 'error']),
    modelId: z.literal(VOICE_MODEL_ID),
    revision: z.literal(VOICE_MODEL_REVISION),
    localOnly: z.literal(true),
    detail: z.string().max(2_048).optional(),
  })
  .strict();
export type VoiceModelStatus = z.infer<typeof VoiceModelStatusSchema>;

export const VoiceTranscriptionInputSchema = z
  .object({
    samples: z.instanceof(Float32Array).refine((value) => value.length <= VOICE_MAX_SAMPLES, {
      message: `Voice recordings are limited to ${VOICE_MAX_SECONDS} seconds.`,
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.samples.length < VOICE_SAMPLE_RATE / 4) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['samples'],
        message: 'Voice recordings must be at least a quarter of a second.',
      });
    }
    for (let index = 0; index < value.samples.length; index += 1) {
      const sample = value.samples[index];
      if (sample === undefined || !Number.isFinite(sample) || sample < -1 || sample > 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['samples', index],
          message: 'Voice audio must contain finite normalized samples.',
        });
        return;
      }
    }
  });
export type VoiceTranscriptionInput = z.infer<typeof VoiceTranscriptionInputSchema>;

export const VoiceTranscriptionSchema = z
  .object({
    text: z.string().trim().min(1).max(4_096),
    durationMs: z.number().int().min(0).max(300_000),
  })
  .strict();
export type VoiceTranscription = z.infer<typeof VoiceTranscriptionSchema>;

export const VOICE_IPC_CHANNELS = Object.freeze({
  status: 'voice:model-status',
  install: 'voice:model-install',
  remove: 'voice:model-remove',
  transcribe: 'voice:transcribe',
});
