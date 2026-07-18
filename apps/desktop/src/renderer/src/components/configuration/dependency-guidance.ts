import type { AgentDetection } from '../../../../shared/application/contracts.js';

export type CommandPurpose = 'check' | 'preview' | 'setup';

export function commandDependencyGuidance(executable: string, purpose: CommandPurpose): string {
  const trimmed = executable.trim();
  if (trimmed === '') {
    if (purpose === 'preview') {
      return 'Optional: leave this blank to pick a script from your project after you open it, or use Browse to pick an exact program.';
    }
    if (purpose === 'check') {
      return 'Use Browse to pick a program, type the name of a command installed on this computer, or use a script from the open project.';
    }
    return 'Optional: use Browse to pick an exact program. You can also set this up later in Settings.';
  }

  const command = executableName(trimmed);
  if (command === 'npm' || command === 'npx' || command === 'node') {
    return 'If this command is not available, install Node.js and reopen Forgeboard, or use Browse to point to it directly.';
  }
  if (command === 'pnpm' || command === 'yarn') {
    return `If ${command} is not available, install Node.js and enable ${command} with Corepack, then reopen Forgeboard or use Browse.`;
  }
  if (command === 'bun') {
    return 'If Bun is not available, install Bun and reopen Forgeboard, or use Browse to point to it directly.';
  }
  if (command === 'deno') {
    return 'If Deno is not available, install Deno and reopen Forgeboard, or use Browse to point to it directly.';
  }
  if (isPath(trimmed)) {
    return 'Forgeboard will check this file before running it. If it was moved or replaced, use Browse to pick it again.';
  }
  return `If ${trimmed} is not available on this computer, install it and reopen Forgeboard, or use Browse to point to it directly.`;
}

export function packageManagerDependencyGuidance(
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun',
): string {
  return commandDependencyGuidance(packageManager, 'preview');
}

export function agentDependencyGuidance(
  agent: AgentDetection | undefined,
  fallbackId: string,
): string {
  const id = agent?.id ?? fallbackId;
  if (id === 'test-agent') {
    return 'The test agent comes with Forgeboard. If its program is missing, reinstall the app.';
  }
  if (id === 'custom') {
    return 'Use Browse to pick the program that runs your custom agent, add its version arguments, then refresh. No manifest or environment file is needed.';
  }
  const provider =
    id === 'codex'
      ? 'OpenAI Codex CLI'
      : id === 'claude'
        ? 'Claude Code'
        : id === 'gemini'
          ? 'Gemini CLI'
          : id === 'opencode'
            ? 'OpenCode'
            : (agent?.label ?? id);
  const expectedCommand =
    id === 'codex'
      ? 'codex'
      : id === 'claude'
        ? 'claude'
        : id === 'gemini'
          ? 'gemini'
          : id === 'opencode'
            ? 'opencode'
            : id;
  return `Install ${provider} by following its publisher's instructions, make sure the ${expectedCommand} command works on this computer, and reopen Forgeboard. Or use Browse to point to an existing installation, then refresh.`;
}

function executableName(executable: string): string {
  const normalized = executable.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  return base.replace(/\.(?:cmd|exe)$/u, '');
}

function isPath(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\') || /^[A-Za-z]:/u.test(executable);
}
