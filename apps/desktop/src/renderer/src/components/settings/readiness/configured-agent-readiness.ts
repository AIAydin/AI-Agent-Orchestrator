import type { AgentDetection, AppSettings } from '../../../../../shared/application/contracts.js';
import type {
  AgentReadinessRequest,
  AgentReadinessResult,
  ReadinessAgentId,
} from '../../../../../shared/readiness/contracts.js';
import {
  configuredReadinessAgentIds,
  expectedReadinessSource,
  settingsAgentReadinessRequestChanged,
} from '../../../../../shared/settings/readiness-requests.js';
import {
  currentReadinessResult,
  launchDetectionIsReady,
  readinessDraftForAgent,
  type AgentReadinessDraft,
} from '../../readiness/readiness-ui.js';

export type ConfiguredAgentReadinessPhase =
  | 'ready'
  | 'checking'
  | 'needs-check'
  | 'blocked'
  | 'invalid'
  | 'unavailable';

export interface ConfiguredAgentReadinessEntry {
  readonly agentId: ReadinessAgentId;
  readonly agent: AgentDetection | undefined;
  readonly label: string;
  readonly draft: AgentReadinessDraft;
  readonly result: AgentReadinessResult | null;
  readonly phase: ConfiguredAgentReadinessPhase;
  readonly evidence: 'launch-detection' | 'current-probe' | null;
  readonly blockingIssue: string | null;
}

interface ReadinessEvidence {
  readonly results: Readonly<Record<string, AgentReadinessResult>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly checking: ReadonlySet<string>;
  readonly checkerAvailable: boolean;
}

export { configuredReadinessAgentIds } from '../../../../../shared/settings/readiness-requests.js';

export function configuredAgentReadinessEntries(
  settings: AppSettings,
  persistedSettings: AppSettings,
  agents: readonly AgentDetection[],
  evidence: ReadinessEvidence,
): ConfiguredAgentReadinessEntry[] {
  return configuredReadinessAgentIds(settings).map((agentId) => {
    const agent = agents.find((candidate) => candidate.id === agentId);
    const label =
      agent?.label ??
      (agentId === 'custom' ? settings.customAgent.name.trim() || 'Custom agent' : agentId);
    const draft = readinessDraftForAgent(settings, agentId);
    const result = currentReadinessResult(evidence.results, draft);
    const error = evidence.errors[draft.fingerprint];

    if (draft.issue !== null) {
      return entry('invalid', `${label}: ${draft.issue}`);
    }
    if (evidence.checking.has(draft.fingerprint)) {
      return entry('checking', `${label} is still being checked against your current settings.`);
    }
    if (error !== undefined) return entry('unavailable', `${label}: ${error}`);
    if (result !== null) {
      if (!agentReadinessResultMatchesRequest(result, draft.request)) {
        return entry(
          'unavailable',
          `${label}: The last check was for different settings, so Forgeboard ignored it. Refresh readiness again.`,
        );
      }
      if (result.ready) return entry('ready', null, 'current-probe');
      return entry('blocked', `${label}: ${result.reason ?? 'This program is not ready.'}`);
    }
    if (canUseLaunchDetection(settings, persistedSettings, agentId, agent, draft)) {
      return entry('ready', null, 'launch-detection');
    }
    if (!evidence.checkerAvailable) {
      return entry(
        'unavailable',
        `${label}: Readiness checks are unavailable right now. Reopen Forgeboard before saving.`,
      );
    }
    return entry(
      'needs-check',
      `${label}: Refresh readiness for the current program before saving settings.`,
    );

    function entry(
      phase: ConfiguredAgentReadinessPhase,
      blockingIssue: string | null,
      readyEvidence: ConfiguredAgentReadinessEntry['evidence'] = null,
    ): ConfiguredAgentReadinessEntry {
      return {
        agentId,
        agent,
        label,
        draft,
        result,
        phase,
        evidence: readyEvidence,
        blockingIssue,
      };
    }
  });
}

export function agentReadinessResultMatchesRequest(
  result: AgentReadinessResult,
  request: AgentReadinessRequest | null,
): boolean {
  if (request === null || result.agentId !== request.agentId) return false;
  return result.source === expectedReadinessSource(request);
}

function canUseLaunchDetection(
  settings: AppSettings,
  persistedSettings: AppSettings,
  agentId: ReadinessAgentId,
  agent: AgentDetection | undefined,
  draft: AgentReadinessDraft,
): boolean {
  if (
    agentId !== settings.defaultAgent ||
    draft.request === null ||
    settingsAgentReadinessRequestChanged(persistedSettings, settings, draft.request)
  ) {
    return false;
  }
  return launchDetectionIsReady(agent, draft);
}
