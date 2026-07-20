import type {
  AgentDetection,
  PermissionProfile,
} from '../../../../../../shared/application/contracts.js';
import type { TerminalNodeConfiguration } from '../../terminal/types.js';

export interface AgentSessionLaunch {
  readonly configuration: TerminalNodeConfiguration;
  readonly profileNote: string | null;
}

/**
 * The model CLI flag each adapter accepts, hardcoded here to mirror the manifest `modelArguments`
 * in `@forgeboard/agent-adapters` without importing across the package boundary. An adapter absent
 * from this map cannot receive a typed model, so its Model field must stay hidden.
 */
const MODEL_FLAG_BY_ADAPTER: Readonly<Record<string, string>> = {
  claude: '--model',
  codex: '-m',
  gemini: '--model',
  opencode: '--model',
};

/**
 * Whether a typed model reaches the launched command for this adapter. Callers gate the Model input
 * on this so a visible Model field always affects the command it produces.
 */
export function modelFlagSupported(adapterId: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_FLAG_BY_ADAPTER, adapterId);
}

/** Why an interactive session cannot start, or null when it can. */
export function agentSessionUnavailableReason(agent: AgentDetection | undefined): string | null {
  if (agent === undefined) return 'Pick an installed agent to start a session.';
  if (!agent.installed || agent.executable === null) {
    return `${agent.label} isn't installed on this computer. Install it or pick another agent.`;
  }
  return null;
}

export function agentSessionLaunch(
  agent: AgentDetection,
  model: string | undefined,
  profile: PermissionProfile,
): AgentSessionLaunch {
  const executable = agent.executable ?? '';
  const trimmedModel = model?.trim() ?? '';
  const args: string[] = [];
  let enforced = false;
  if (agent.id === 'claude') {
    if (profile === 'plan-read-only') {
      args.push('--permission-mode', 'plan');
      enforced = true;
    }
  } else if (agent.id === 'codex') {
    if (profile === 'plan-read-only') {
      args.push('--sandbox', 'read-only');
      enforced = true;
    }
  }
  const modelFlag = MODEL_FLAG_BY_ADAPTER[agent.id];
  if (modelFlag !== undefined && trimmedModel !== '') {
    args.push(modelFlag, trimmedModel);
  }
  return {
    configuration: {
      executable,
      arguments: args,
      cwdRelative: '',
      environmentVariableNames: [],
    },
    profileNote: enforced
      ? null
      : 'Interactive sessions run at the project root; this profile fully applies to flow runs. The CLI asks before writing.',
  };
}
