import { MachineSpecificValueSchema } from '../../../shared/settings/values.js';

export interface TerminalExecutableDefaultInput {
  readonly platform: NodeJS.Platform;
  readonly environmentShell?: string | undefined;
}

/** Derives a direct executable default without trusting Unix SHELL on Windows. */
export function defaultTerminalExecutable({
  platform,
  environmentShell,
}: TerminalExecutableDefaultInput): string {
  if (platform === 'win32') return 'powershell.exe';
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  const parsed = MachineSpecificValueSchema.safeParse(environmentShell);
  if (!parsed.success || !parsed.data.startsWith('/')) return fallback;
  return parsed.data;
}
