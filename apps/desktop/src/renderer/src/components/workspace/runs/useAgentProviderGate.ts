import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ProviderConnectionId,
  ProviderConnectionStatus,
} from '../../../../../shared/provider-connections/index.js';
import {
  PROVIDER_CONNECTION_PRODUCTS,
  fetchProviderConnectionStatus,
  performProviderConnectionAction,
  providerConnectionErrorMessage,
  providerConnectionIdForAdapter,
} from '../../../lib/provider-connections.js';

/** Run-gate view of one provider-backed agent's OAuth connection. */
export interface AgentProviderGate {
  readonly providerId: ProviderConnectionId;
  readonly productName: string;
  readonly state: 'checking' | 'connected' | 'disconnected' | 'unknown';
  /** True once a status check finished (successfully or not). */
  readonly settled: boolean;
  /** True while a status check or refresh for this provider is running. */
  readonly busy: boolean;
  /** Why runs are blocked; null when the provider is connected. */
  readonly blockedReason: string | null;
  /** Inline warning copy; null when connected or still checking silently. */
  readonly warning: string | null;
  readonly actionLabel: string;
  readonly busyActionLabel: string;
}

interface GateRecord {
  readonly status: ProviderConnectionStatus | null;
  readonly busyAction: 'check' | 'refresh' | null;
  readonly error: string | null;
}

interface UseAgentProviderGateInput {
  /** Every adapter whose provider connection the workspace should watch. */
  readonly adapterIds: readonly string[];
  readonly executableOverrides?: Partial<Record<ProviderConnectionId, string>>;
}

/**
 * Reads and caches the provider-connection status of Claude Code and Codex
 * CLI for run gating. Statuses load once per provider on demand and refresh
 * only when asked — there is no polling. Agents without a provider
 * connection are never gated.
 */
export function useAgentProviderGate({
  adapterIds,
  executableOverrides = {},
}: UseAgentProviderGateInput) {
  const codexOverride = executableOverrides.codex?.trim() ?? '';
  const claudeOverride = executableOverrides.claude?.trim() ?? '';
  const overridesKey = `${codexOverride}|${claudeOverride}`;
  const [records, setRecords] = useState<Partial<Record<ProviderConnectionId, GateRecord>>>({});
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const startedRef = useRef({ overridesKey, providers: new Set<ProviderConnectionId>() });
  const inFlightRef = useRef(new Set<ProviderConnectionId>());

  const update = useCallback((providerId: ProviderConnectionId, change: Partial<GateRecord>) => {
    setRecords((current) => ({
      ...current,
      [providerId]: {
        ...(current[providerId] ?? { status: null, busyAction: null, error: null }),
        ...change,
      },
    }));
  }, []);

  const overrideFor = useCallback(
    (providerId: ProviderConnectionId) => (providerId === 'codex' ? codexOverride : claudeOverride),
    [claudeOverride, codexOverride],
  );

  const check = useCallback(
    async (providerId: ProviderConnectionId) => {
      if (inFlightRef.current.has(providerId)) return;
      inFlightRef.current.add(providerId);
      update(providerId, { busyAction: 'check', error: null });
      try {
        const status = await fetchProviderConnectionStatus(providerId, overrideFor(providerId));
        update(providerId, { status, busyAction: null, error: null });
      } catch (cause) {
        update(providerId, { busyAction: null, error: providerConnectionErrorMessage(cause) });
      } finally {
        inFlightRef.current.delete(providerId);
      }
    },
    [overrideFor, update],
  );

  const refresh = useCallback(
    async (providerId: ProviderConnectionId) => {
      if (inFlightRef.current.has(providerId)) return;
      inFlightRef.current.add(providerId);
      update(providerId, { busyAction: 'refresh', error: null });
      try {
        const status = await performProviderConnectionAction(
          providerId,
          'refresh',
          overrideFor(providerId),
        );
        update(providerId, status === null ? { busyAction: null } : { status, busyAction: null });
      } catch (cause) {
        update(providerId, { busyAction: null, error: providerConnectionErrorMessage(cause) });
      } finally {
        inFlightRef.current.delete(providerId);
      }
    },
    [overrideFor, update],
  );

  /** Re-checks a provider; an unknown status runs the provider refresh flow. */
  const recheck = useCallback(
    async (providerId: ProviderConnectionId) => {
      const record = recordsRef.current[providerId];
      const state = record?.status?.state ?? (record?.error != null ? 'unknown' : 'checking');
      await (state === 'unknown' ? refresh(providerId) : check(providerId));
    },
    [check, refresh],
  );

  useEffect(() => {
    if (startedRef.current.overridesKey !== overridesKey) {
      startedRef.current = { overridesKey, providers: new Set() };
    }
    for (const adapterId of adapterIds) {
      const providerId = providerConnectionIdForAdapter(adapterId);
      if (providerId === null || startedRef.current.providers.has(providerId)) continue;
      startedRef.current.providers.add(providerId);
      void check(providerId);
    }
  }, [adapterIds.join('|'), overridesKey, check]);

  const gateFor = useCallback(
    (adapterId: string): AgentProviderGate | null => {
      const providerId = providerConnectionIdForAdapter(adapterId);
      if (providerId === null) return null;
      return buildGate(providerId, records[providerId]);
    },
    [records],
  );

  /**
   * Fresh approval-time check. Returns null when the run may start, or a
   * cause-and-recovery message when it must not. Failures block the run.
   */
  const verifyAdapterConnection = useCallback(
    async (adapterId: string): Promise<string | null> => {
      const providerId = providerConnectionIdForAdapter(adapterId);
      if (providerId === null) return null;
      const product = PROVIDER_CONNECTION_PRODUCTS[providerId];
      try {
        const status = await fetchProviderConnectionStatus(providerId, overrideFor(providerId));
        update(providerId, { status, error: null });
        if (status.state === 'connected') return null;
        return status.state === 'unknown'
          ? `${product}'s connection status needs a refresh — refresh it on this Agent node or in Settings → Agents & runtime, then try again.`
          : `${product} isn't connected — connect it in Settings → Agents & runtime, then try again.`;
      } catch (cause) {
        return `${product}'s connection could not be verified (${providerConnectionErrorMessage(cause)}) — check Settings → Agents & runtime, then try again.`;
      }
    },
    [overrideFor, update],
  );

  return { gateFor, recheck, verifyAdapterConnection };
}

function buildGate(
  providerId: ProviderConnectionId,
  record: GateRecord | undefined,
): AgentProviderGate {
  const productName = PROVIDER_CONNECTION_PRODUCTS[providerId];
  const settled = record !== undefined && (record.status !== null || record.error !== null);
  const state = record?.status?.state ?? (record?.error != null ? 'unknown' : 'checking');
  const disconnectedCopy = `${productName} isn't connected. Connect it in Settings → Agents & runtime.`;
  const blockedReason =
    state === 'connected'
      ? null
      : state === 'checking'
        ? `Checking the ${productName} connection…`
        : state === 'disconnected'
          ? disconnectedCopy
          : `${productName}'s connection status needs a refresh. Refresh it, then try again.`;
  const warning =
    record?.error != null
      ? `${productName}'s connection status could not be checked: ${record.error}`
      : state === 'disconnected'
        ? disconnectedCopy
        : state === 'unknown'
          ? `${productName}'s connection status needs a refresh before this agent can run.`
          : null;
  const refreshes = state === 'unknown';
  return {
    providerId,
    productName,
    state,
    settled,
    busy: record?.busyAction != null,
    blockedReason,
    warning,
    actionLabel: refreshes ? 'Refresh status' : 'Check again',
    busyActionLabel:
      record?.busyAction === 'refresh' || (record?.busyAction == null && refreshes)
        ? 'Refreshing status…'
        : 'Checking again…',
  };
}
