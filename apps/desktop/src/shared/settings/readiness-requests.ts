import type { AppSettings, CommandConfiguration } from '../application/contracts.js';
import {
  CommandReadinessRequestSchema,
  type CommandReadinessPurpose,
  type CommandReadinessRequest,
} from '../command-readiness/contracts.js';
import {
  AgentReadinessRequestSchema,
  type AgentReadinessRequest,
  type AgentReadinessResult,
  type ReadinessAgentId,
} from '../readiness/contracts.js';

const CONFIGURABLE_BUILT_INS = ['codex', 'claude', 'gemini', 'opencode'] as const;

export interface SettingsCommandReadinessDraft {
  readonly id: string;
  readonly label: string;
  readonly purpose: CommandReadinessPurpose;
  readonly command: CommandConfiguration;
}

export function configuredReadinessAgentIds(settings: AppSettings): ReadinessAgentId[] {
  const configured = new Set<ReadinessAgentId>([settings.defaultAgent]);
  for (const agentId of CONFIGURABLE_BUILT_INS) {
    if (
      settings.agentExecutableOverrides[agentId]?.trim() ||
      settings.agentDefaultModels[agentId]?.trim()
    ) {
      configured.add(agentId);
    }
  }
  if (settings.customAgent.enabled) configured.add('custom');
  return [...configured];
}

export function agentReadinessRequestCandidate(
  settings: AppSettings,
  agentId: ReadinessAgentId,
): unknown {
  const executableOverride = settings.agentExecutableOverrides[agentId]?.trim();
  if (agentId === 'custom') return { agentId, configuration: settings.customAgent };
  return { agentId, ...(executableOverride ? { executableOverride } : {}) };
}

export function settingsAgentReadinessRequests(settings: AppSettings): AgentReadinessRequest[] {
  return configuredReadinessAgentIds(settings).map((agentId) =>
    AgentReadinessRequestSchema.parse(agentReadinessRequestCandidate(settings, agentId)),
  );
}

export function settingsAgentReadinessRequestChanged(
  persistedSettings: AppSettings,
  draftSettings: AppSettings,
  request: AgentReadinessRequest,
): boolean {
  if (
    request.agentId === draftSettings.defaultAgent &&
    persistedSettings.defaultAgent !== draftSettings.defaultAgent
  ) {
    return true;
  }
  const persistedRequest = settingsAgentReadinessRequests(persistedSettings).find(
    (candidate) => candidate.agentId === request.agentId,
  );
  return (
    persistedRequest === undefined ||
    readinessRequestFingerprint(persistedRequest) !== readinessRequestFingerprint(request)
  );
}

export function readinessRequestFingerprint(request: AgentReadinessRequest): string {
  return JSON.stringify(AgentReadinessRequestSchema.parse(request));
}

export function expectedReadinessSource(
  request: AgentReadinessRequest,
): AgentReadinessResult['source'] {
  if (request.agentId === 'custom') return 'custom';
  return request.executableOverride === undefined ? 'automatic' : 'override';
}

export function settingsCommandReadinessDrafts(
  settings: AppSettings,
): SettingsCommandReadinessDraft[] {
  return [
    standardCommand('terminal-default', 'Default terminal executable', 'terminal', {
      executable: settings.terminalShell,
      arguments: [],
    }),
    standardCommand('development', 'Development server', 'preview', settings.developmentCommand),
    standardCommand('check-lint', 'Lint command', 'check', settings.lintCommand),
    standardCommand('check-typecheck', 'Typecheck command', 'check', settings.typecheckCommand),
    standardCommand('check-test', 'Test command', 'check', settings.testCommand),
    standardCommand('check-build', 'Build command', 'check', settings.buildCommand),
    ...(settings.customChecks ?? []).map(
      (check): SettingsCommandReadinessDraft => ({
        id: `check-custom-${check.id}`,
        label: check.label.trim() || 'Custom check',
        purpose: 'check',
        command: check.command,
      }),
    ),
  ];
}

export function commandNeedsReadiness(input: Pick<CommandReadinessRequest, 'command'>): boolean {
  return input.command.executable.trim() !== '' || input.command.arguments.length > 0;
}

export function settingsCommandFingerprint(
  input: Pick<CommandReadinessRequest, 'purpose' | 'command'>,
): string {
  const parsed = CommandReadinessRequestSchema.parse({
    purpose: input.purpose,
    command: input.command,
    projectId: null,
  });
  return JSON.stringify({ purpose: parsed.purpose, command: parsed.command });
}

function standardCommand(
  id: string,
  label: string,
  purpose: CommandReadinessPurpose,
  command: CommandConfiguration,
): SettingsCommandReadinessDraft {
  return { id, label, purpose, command };
}
