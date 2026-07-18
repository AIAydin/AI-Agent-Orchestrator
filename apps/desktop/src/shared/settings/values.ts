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
  .max(MAX_MACHINE_PATH_LENGTH, 'Machine paths must be at most 32,768 characters.')
  .refine((value) => !containsControlCharacter(value), {
    message: 'Machine paths cannot contain control characters.',
  });

export const MachineSpecificValueSchema = MachinePathValueSchema.refine(
  (value) => value.trim() !== '',
  { message: 'Choose a machine path.' },
).refine((value) => value === value.trim(), {
  message: 'Machine paths cannot begin or end with whitespace.',
});

export const OptionalMachineSpecificValueSchema = MachinePathValueSchema.refine(
  (value) => value === '' || (value.trim() !== '' && value === value.trim()),
  {
    message: 'Machine paths must be empty or cannot begin or end with whitespace.',
  },
);

export const MachineSpecificPathSchema = MachineSpecificValueSchema.refine(isAbsoluteMachinePath, {
  message: 'Choose an absolute machine path with Browse.',
});

export const OptionalMachineSpecificPathSchema = OptionalMachineSpecificValueSchema.refine(
  (value) => value === '' || isAbsoluteMachinePath(value),
  {
    message: 'Machine paths must be empty or absolute paths selected with Browse.',
  },
);

/** True when an executable would resolve relative to whichever project happens to be open. */
export function isProjectRelativeExecutable(value: string): boolean {
  return (
    !isAbsoluteMachinePath(value) &&
    (value.includes('/') || value.includes('\\') || /^[A-Za-z]:/u.test(value))
  );
}

export const TerminalExecutableSettingSchema = MachineSpecificValueSchema.refine(
  (value) => !isProjectRelativeExecutable(value),
  {
    message:
      'Choose an absolute executable path or an installed command name that works across projects.',
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
  .min(1, 'Add at least one loopback host.')
  .max(MAX_PREVIEW_HOST_LENGTH, 'Preview hosts must be at most 512 characters.')
  .refine((value) => normalizePreviewLoopbackHost(value) !== null, {
    message: 'Preview trusted hosts must be loopback-only hostnames or IP addresses.',
  });

export const PreviewTrustedHostsSchema = z
  .array(PreviewLoopbackHostSchema)
  .min(1, 'Add at least one loopback preview host.')
  .max(MAX_PREVIEW_HOSTS, 'Configure at most 128 preview hosts.')
  .superRefine((hosts, context) => {
    const normalized = new Set<string>();
    hosts.forEach((host, index) => {
      const value = normalizePreviewLoopbackHost(host);
      if (value === null) return;
      if (normalized.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Preview trusted hosts must be unique after normalization.',
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
