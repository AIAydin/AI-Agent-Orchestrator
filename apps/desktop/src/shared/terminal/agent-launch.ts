import type { PermissionProfile } from '../application/contracts.js';

const MODEL_FLAG_BY_ADAPTER: Readonly<Record<string, string>> = {
  claude: '--model',
  codex: '-m',
  gemini: '--model',
  opencode: '--model',
};

/**
 * Whether Forgeboard has a built-in, deterministic interactive command shape for this adapter.
 * Custom and extension-provided adapters intentionally stay outside the automatic-launch path.
 */
export function builtInAgentModelFlagSupported(adapterId: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_FLAG_BY_ADAPTER, adapterId);
}

/**
 * Builds the argument vector used by an interactive Agent node. Returning `null` means the
 * adapter is not built in and its command must continue through explicit native review.
 */
export function builtInAgentSessionArguments(
  adapterId: string,
  model: string | null | undefined,
  profile: PermissionProfile,
  extraArguments: readonly string[] = [],
): string[] | null {
  const modelFlag = MODEL_FLAG_BY_ADAPTER[adapterId];
  if (modelFlag === undefined) return null;

  const arguments_: string[] = [];
  if (profile === 'plan-read-only') {
    if (adapterId === 'claude') {
      arguments_.push('--permission-mode', 'plan');
    } else if (adapterId === 'codex') {
      arguments_.push('--sandbox', 'read-only');
    }
  }

  const trimmedModel = model?.trim() ?? '';
  if (trimmedModel !== '') arguments_.push(modelFlag, trimmedModel);
  arguments_.push(...extraArguments);
  return arguments_;
}
