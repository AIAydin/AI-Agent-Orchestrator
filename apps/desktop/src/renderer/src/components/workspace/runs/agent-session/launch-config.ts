import type {
  AgentDetection,
  PermissionProfile,
} from '../../../../../../shared/application/contracts.js';
import {
  builtInAgentModelFlagSupported,
  builtInAgentSessionArguments,
} from '../../../../../../shared/terminal/index.js';
import type { TerminalNodeConfiguration } from '../../terminal/types.js';

export interface AgentSessionLaunch {
  readonly configuration: TerminalNodeConfiguration;
  readonly profileNote: string | null;
}

/** Peer-channel material to thread into the launch command, or null when no peer channel applies. */
export interface AgentSessionPeerLaunchMaterial {
  readonly provisionId: string;
  readonly extraArguments: readonly string[];
}

/**
 * Whether a typed model reaches the launched command for this adapter. Callers gate the Model input
 * on this so a visible Model field always affects the command it produces.
 */
export function modelFlagSupported(adapterId: string): boolean {
  return builtInAgentModelFlagSupported(adapterId);
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
  peers: AgentSessionPeerLaunchMaterial | null = null,
): AgentSessionLaunch {
  const executable = agent.executable ?? '';
  const args = builtInAgentSessionArguments(
    agent.id,
    model,
    profile,
    peers?.extraArguments ?? [],
  ) ?? [...(peers?.extraArguments ?? [])];
  let enforced = false;
  if (agent.id === 'claude') {
    if (profile === 'plan-read-only') {
      enforced = true;
    }
  } else if (agent.id === 'codex') {
    if (profile === 'plan-read-only') {
      enforced = true;
    }
  }
  // worktree-write runs in a managed worktree; project-write runs right in the project
  // directory by design — both do exactly what their labels promise.
  if (profile === 'worktree-write' || profile === 'project-write') enforced = true;
  return {
    configuration: {
      executable,
      arguments: args,
      cwdRelative: '.',
      environmentVariableNames: [],
      ...(profile === 'worktree-write'
        ? {
            workspace: {
              kind: 'managed-agent-worktree' as const,
              adapterId: agent.id,
            },
          }
        : profile === 'project-write'
          ? // Runs right in the project directory; main reconstructs and authorizes the launch
            // from the persisted node, so no native confirmation interrupts the zero-click start.
            { workspace: { kind: 'project' as const } }
          : {}),
      ...(peers !== null ? { peerProvisionId: peers.provisionId } : {}),
    },
    profileNote: enforced
      ? null
      : 'This interactive profile is not enforced yet. The session runs at the project root and the CLI asks before writing.',
  };
}
