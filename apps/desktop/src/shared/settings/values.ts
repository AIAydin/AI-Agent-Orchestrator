import { z } from 'zod';

const MAX_MACHINE_PATH_LENGTH = 32_768;
const MAX_PREVIEW_HOST_LENGTH = 512;
const MAX_PREVIEW_HOSTS = 128;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

const MachinePathValueSchema = z
  .string()
  .max(MAX_MACHINE_PATH_LENGTH, 'Paths must be at most 32,768 characters.')
  .refine((value) => !containsControlCharacter(value), {
    message: 'Paths cannot contain non-printing characters.',
  });

export const MachineSpecificValueSchema = MachinePathValueSchema.refine(
  (value) => value.trim() !== '',
  { message: 'Choose a path.' },
).refine((value) => value === value.trim(), {
  message: 'Paths cannot begin or end with a space.',
});

export const OptionalMachineSpecificValueSchema = MachinePathValueSchema.refine(
  (value) => value === '' || (value.trim() !== '' && value === value.trim()),
  {
    message: 'Paths can be empty, but cannot begin or end with a space.',
  },
);

export const MachineSpecificPathSchema = MachineSpecificValueSchema.refine(isAbsoluteMachinePath, {
  message: 'Choose a full path with Browse.',
});

export const OptionalMachineSpecificPathSchema = OptionalMachineSpecificValueSchema.refine(
  (value) => value === '' || isAbsoluteMachinePath(value),
  {
    message: 'Leave this empty or choose a full path with Browse.',
  },
);

export function normalizePreviewLoopbackHost(value: string): string | null {
  if (value !== value.trim() || value === '' || containsControlCharacter(value)) return null;
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const normalized = unwrapped.toLowerCase().replace(/\.$/u, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return normalized;
  }
  const octets = normalized.split('.');
  if (
    octets.length !== 4 ||
    octets[0] !== '127' ||
    octets.some((octet) => !/^(0|[1-9][0-9]{0,2})$/u.test(octet) || Number(octet) > 255)
  ) {
    return null;
  }
  return normalized;
}

export const PreviewLoopbackHostSchema = z
  .string()
  .min(1, 'Enter a trusted preview host.')
  .max(MAX_PREVIEW_HOST_LENGTH, 'Trusted preview hosts must be at most 512 characters.')
  .refine((value) => normalizePreviewLoopbackHost(value) !== null, {
    message: 'Use localhost or a 127.x.x.x address — previews can only trust this computer.',
  });

export const PreviewTrustedHostsSchema = z
  .array(PreviewLoopbackHostSchema)
  .min(1, 'Add at least one trusted preview host.')
  .max(MAX_PREVIEW_HOSTS, 'Add at most 128 trusted preview hosts.')
  .superRefine((hosts, context) => {
    const normalized = new Set<string>();
    hosts.forEach((host, index) => {
      const value = normalizePreviewLoopbackHost(host);
      if (value === null) return;
      if (normalized.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Each trusted preview host can appear only once.',
        });
      }
      normalized.add(value);
    });
  });

function isAbsoluteMachinePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value)
  );
}
