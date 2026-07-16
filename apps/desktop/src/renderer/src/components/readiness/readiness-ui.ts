import type { AgentDetection, AppSettings } from '../../../../shared/application/contracts.js';
import {
  AgentReadinessRequestSchema,
  ReadinessAgentIdSchema,
  type AgentReadinessRequest,
  type AgentReadinessResult,
  type ReadinessAgentId,
} from '../../../../shared/readiness/contracts.js';
import {
  agentReadinessRequestCandidate,
  readinessRequestFingerprint,
} from '../../../../shared/settings/readiness-requests.js';

export interface AgentReadinessDraft {
  readonly request: AgentReadinessRequest | null;
  readonly fingerprint: string;
  readonly issue: string | null;
}

export function isReadinessAgentId(value: string): value is ReadinessAgentId {
  return ReadinessAgentIdSchema.safeParse(value).success;
}

export function readinessDraftForAgent(
  settings: AppSettings,
  agentId: ReadinessAgentId,
): AgentReadinessDraft {
  const candidate = agentReadinessRequestCandidate(settings, agentId);
  const parsed = AgentReadinessRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      request: null,
      fingerprint: `invalid:${agentId}:${JSON.stringify(candidate)}`,
      issue: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }
  return {
    request: parsed.data,
    fingerprint: readinessRequestFingerprint(parsed.data),
    issue: null,
  };
}

export function launchDetectionIsReady(
  detection: AgentDetection | undefined,
  draft: AgentReadinessDraft,
): boolean {
  if (
    detection === undefined ||
    !detection.installed ||
    !detection.executable?.trim() ||
    !detection.version?.trim() ||
    draft.request === null
  ) {
    return false;
  }
  if (draft.request.agentId === 'custom') return false;
  return draft.request.agentId === 'test-agent' || draft.request.executableOverride === undefined;
}

export function currentReadinessResult(
  results: Readonly<Record<string, AgentReadinessResult>>,
  draft: AgentReadinessDraft,
): AgentReadinessResult | null {
  return results[draft.fingerprint] ?? null;
}
