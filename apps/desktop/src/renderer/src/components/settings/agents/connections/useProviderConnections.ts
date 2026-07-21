import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ProviderConnectionAction,
  ProviderConnectionId,
  ProviderConnectionStatus,
} from '../../../../../../shared/provider-connections/index.js';
import {
  fetchProviderConnectionStatus,
  performProviderConnectionAction,
  providerConnectionErrorMessage,
} from '../../../../lib/provider-connections.js';
import { unwrap } from '../../../../lib/ipc.js';

export interface ProviderConnectionView {
  readonly status: ProviderConnectionStatus | null;
  readonly loading: boolean;
  readonly activeAction: ProviderConnectionAction | null;
  readonly error: string | null;
}

const EMPTY_VIEW: ProviderConnectionView = {
  status: null,
  loading: true,
  activeAction: null,
  error: null,
};

export function useProviderConnections(
  providerIds: readonly ProviderConnectionId[],
  executableOverrides: Partial<Record<ProviderConnectionId, string>> = {},
) {
  const codexOverride = executableOverrides.codex?.trim() ?? '';
  const claudeOverride = executableOverrides.claude?.trim() ?? '';
  const [views, setViews] = useState<Partial<Record<ProviderConnectionId, ProviderConnectionView>>>(
    {},
  );
  const activePlans = useRef(new Map<ProviderConnectionId, string>());

  const update = useCallback(
    (providerId: ProviderConnectionId, change: Partial<ProviderConnectionView>) => {
      setViews((current) => ({
        ...current,
        [providerId]: { ...(current[providerId] ?? EMPTY_VIEW), ...change },
      }));
    },
    [],
  );

  const load = useCallback(
    async (providerId: ProviderConnectionId) => {
      update(providerId, { loading: true, error: null });
      try {
        const status = await fetchProviderConnectionStatus(
          providerId,
          providerId === 'codex' ? codexOverride : claudeOverride,
        );
        update(providerId, { status, loading: false });
        return status;
      } catch (cause) {
        update(providerId, { loading: false, error: providerConnectionErrorMessage(cause) });
        return null;
      }
    },
    [claudeOverride, codexOverride, update],
  );

  useEffect(() => {
    for (const providerId of providerIds) void load(providerId);
  }, [providerIds.join('|'), load]);

  const perform = useCallback(
    async (providerId: ProviderConnectionId, action: ProviderConnectionAction) => {
      update(providerId, { activeAction: action, error: null });
      try {
        const status = await performProviderConnectionAction(
          providerId,
          action,
          providerId === 'codex' ? codexOverride : claudeOverride,
          (planId) => activePlans.current.set(providerId, planId),
        );
        if (status) update(providerId, { status });
      } catch (cause) {
        update(providerId, { error: providerConnectionErrorMessage(cause) });
      } finally {
        activePlans.current.delete(providerId);
        update(providerId, { activeAction: null, loading: false });
      }
    },
    [claudeOverride, codexOverride, update],
  );

  const cancel = useCallback(
    async (providerId: ProviderConnectionId) => {
      const planId = activePlans.current.get(providerId);
      if (!planId) return;
      try {
        unwrap(await window.forgeboard.agents.connections.cancel({ planId }));
      } catch (cause) {
        update(providerId, { error: providerConnectionErrorMessage(cause) });
      }
    },
    [update],
  );

  return { views, load, perform, cancel };
}
