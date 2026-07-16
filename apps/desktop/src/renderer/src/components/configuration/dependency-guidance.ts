import type { AgentDetection } from '../../../../shared/application/contracts.js';

export type CommandPurpose = 'check' | 'preview' | 'setup';

export function commandDependencyGuidance(executable: string, purpose: CommandPurpose): string {
  const trimmed = executable.trim();
  if (trimmed === '') {
    if (purpose === 'preview') {
      return 'Optional: leave this blank to choose a detected package script after opening a project, or use Browse to select an exact executable.';
    }
    if (purpose === 'check') {
      return 'Choose an executable with Browse, enter a command available on PATH, or adopt a detected package script from the open project.';
    }
    return 'Optional: use Browse to select an exact executable. You can also configure this later in Settings.';
  }

  const command = executableName(trimmed);
  if (command === 'npm' || command === 'npx' || command === 'node') {
    return 'If this command is unavailable, install Node.js, reopen Forgeboard, or use Browse to select its exact executable.';
  }
  if (command === 'pnpm' || command === 'yarn') {
    return `If ${command} is unavailable, install Node.js and enable ${command} with Corepack, then reopen Forgeboard or use Browse.`;
  }
  if (command === 'bun') {
    return 'If Bun is unavailable, install Bun, reopen Forgeboard, or use Browse to select its exact executable.';
  }
  if (command === 'deno') {
    return 'If Deno is unavailable, install Deno, reopen Forgeboard, or use Browse to select its exact executable.';
  }
  if (isPath(trimmed)) {
    return 'Forgeboard will validate this selected file before launch. If it moved or was replaced, use Browse to select it again.';
  }
  return `If ${trimmed} is not available on PATH, install it and reopen Forgeboard, or use Browse to select its exact executable.`;
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
    return 'The deterministic test agent is bundled with Forgeboard; reinstall the application if its executable is missing.';
  }
  if (id === 'custom') {
    return 'Use Browse to select the custom CLI, provide its version arguments, then refresh readiness. No manifest or environment file is required.';
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
  return `Install ${provider} using its provider's current instructions, ensure ${expectedCommand} is on PATH, and reopen Forgeboard; or use Browse to select an existing executable, then refresh readiness.`;
}

function executableName(executable: string): string {
  const normalized = executable.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  return base.replace(/\.(?:cmd|exe)$/u, '');
}

function isPath(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\') || /^[A-Za-z]:/u.test(executable);
}
