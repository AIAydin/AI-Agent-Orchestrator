import type {
  ProviderConnectionAction,
  ProviderConnectionId,
  ProviderConnectionStatus,
} from '../../../shared/provider-connections/index.js';
import { unwrap } from './ipc.js';

/** Human product names for provider-backed agent CLIs. */
export const PROVIDER_CONNECTION_PRODUCTS: Record<ProviderConnectionId, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
};

/**
 * Maps a run adapter to its OAuth provider connection. Only Claude Code and
 * Codex CLI are provider-backed; every other agent has no connection concept.
 */
export function providerConnectionIdForAdapter(adapterId: string): ProviderConnectionId | null {
  return adapterId === 'claude' || adapterId === 'codex' ? adapterId : null;
}

/** Reads the provider's current connection status without running its CLI. */
export async function fetchProviderConnectionStatus(
  providerId: ProviderConnectionId,
  executableOverride = '',
): Promise<ProviderConnectionStatus> {
  const override = executableOverride.trim();
  return unwrap(
    await window.forgeboard.agents.connections.get({
      providerId,
      ...(override === '' ? {} : { executableOverride: override }),
    }),
  );
}

/**
 * Runs a provider connection action through its prepared, natively confirmed
 * plan. Returns the refreshed status, or null when the review was declined.
 */
export async function performProviderConnectionAction(
  providerId: ProviderConnectionId,
  action: ProviderConnectionAction,
  executableOverride = '',
  onPlan?: (planId: string) => void,
): Promise<ProviderConnectionStatus | null> {
  const override = executableOverride.trim();
  const plan = unwrap(
    await window.forgeboard.agents.connections.prepare({
      providerId,
      action,
      ...(override === '' ? {} : { executableOverride: override }),
    }),
  );
  onPlan?.(plan.planId);
  return unwrap(await window.forgeboard.agents.connections.confirm({ planId: plan.planId }));
}

export function providerConnectionErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The provider connection could not be updated.';
}
