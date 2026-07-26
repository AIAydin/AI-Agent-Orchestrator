import { useCallback, useMemo, useRef, useState } from 'react';

import type { AgentDetection, AppSettings } from '../../../../../shared/application/contracts.js';
import {
  AgentReadinessRequestSchema,
  type AgentReadinessResult,
  type CheckAgentReadiness,
} from '../../../../../shared/readiness/contracts.js';
import {
  readinessRequestFingerprint,
  settingsAgentReadinessRequestChanged,
} from '../../../../../shared/settings/readiness-requests.js';
import {
  agentReadinessResultMatchesRequest,
  configuredAgentReadinessEntries,
  configuredReadinessAgentIds,
  type ConfiguredAgentReadinessEntry,
} from './configured-agent-readiness.js';
import { readinessDraftForAgent } from '../../readiness/readiness-ui.js';

export interface SettingsAgentReadinessView {
  readonly entries: readonly ConfiguredAgentReadinessEntry[];
  readonly blockingIssues: readonly string[];
  readonly checkReadiness: CheckAgentReadiness | undefined;
  readonly checking: boolean;
  readonly isChecking: (fingerprint: string) => boolean;
}

export function useSettingsAgentReadiness(
  settings: AppSettings,
  persistedSettings: AppSettings,
  agents: readonly AgentDetection[],
  checker: CheckAgentReadiness | undefined,
): SettingsAgentReadinessView {
  const [results, setResults] = useState<Record<string, AgentReadinessResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const activeFingerprintsRef = useRef<Record<string, string>>({});
  const invalidatedFingerprintsRef = useRef<Set<string>>(new Set());
  const agentEpochsRef = useRef<Record<string, number>>({});
  const activeFingerprints = Object.fromEntries(
    configuredReadinessAgentIds(settings).map((agentId) => [
      agentId,
      readinessDraftForAgent(settings, agentId).fingerprint,
    ]),
  );
  for (const [agentId, previous] of Object.entries(activeFingerprintsRef.current)) {
    if (activeFingerprints[agentId] === previous) continue;
    invalidatedFingerprintsRef.current.add(previous);
    agentEpochsRef.current[agentId] = (agentEpochsRef.current[agentId] ?? 0) + 1;
  }
  activeFingerprintsRef.current = activeFingerprints;

  const checkReadiness = useMemo<CheckAgentReadiness | undefined>(() => {
    if (checker === undefined) return undefined;
    return async (input) => {
      const request = AgentReadinessRequestSchema.parse(input);
      const fingerprint = readinessRequestFingerprint(request);
      const requestEpoch = agentEpochsRef.current[request.agentId] ?? 0;
      setChecking((current) => new Set(current).add(fingerprint));
      setErrors((current) => withoutKey(current, fingerprint));
      try {
        const result = await checker(request);
        if (result === null) {
          throw new Error('Forgeboard did not get a result from the readiness check.');
        }
        if (!agentReadinessResultMatchesRequest(result, request)) {
          throw new Error(
            'The last check was for different settings, so Forgeboard ignored it. Refresh readiness again.',
          );
        }
        if (
          activeFingerprintsRef.current[request.agentId] === fingerprint &&
          (agentEpochsRef.current[request.agentId] ?? 0) === requestEpoch
        ) {
          invalidatedFingerprintsRef.current.delete(fingerprint);
        }
        setResults((current) => ({ ...current, [fingerprint]: result }));
        return result;
      } catch (cause) {
        const message =
          cause instanceof Error && cause.message.trim() !== ''
            ? cause.message
            : 'Forgeboard could not check this agent program.';
        setErrors((current) => ({ ...current, [fingerprint]: message }));
        throw cause;
      } finally {
        setChecking((current) => {
          const next = new Set(current);
          next.delete(fingerprint);
          return next;
        });
      }
    };
  }, [checker]);

  const invalidated = invalidatedFingerprintsRef.current;
  const entries = configuredAgentReadinessEntries(settings, persistedSettings, agents, {
    results: withoutKeys(results, invalidated),
    errors: withoutKeys(errors, invalidated),
    checking: new Set([...checking].filter((fingerprint) => !invalidated.has(fingerprint))),
    checkerAvailable: checker !== undefined,
  });
  const blockingIssues = entries.flatMap((entry) => {
    if (entry.blockingIssue === null) return [];
    const request = entry.draft.request;
    if (
      request !== null &&
      !settingsAgentReadinessRequestChanged(persistedSettings, settings, request)
    ) {
      return [];
    }
    return [entry.blockingIssue];
  });
  const isChecking = useCallback(
    (fingerprint: string) =>
      checking.has(fingerprint) && !invalidatedFingerprintsRef.current.has(fingerprint),
    [checking],
  );
  return {
    entries,
    blockingIssues,
    checkReadiness,
    checking: checking.size > 0,
    isChecking,
  };
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}

function withoutKeys<T>(
  record: Readonly<Record<string, T>>,
  keys: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => !keys.has(candidate)));
}
