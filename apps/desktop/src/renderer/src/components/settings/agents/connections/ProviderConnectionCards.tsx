import { useEffect, type ReactNode } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';

import type {
  ProviderConnectionId,
  ProviderConnectionStatus,
} from '../../../../../../shared/provider-connections/index.js';
import { useProviderConnections } from './useProviderConnections.js';
import './provider-connections.css';

const PROVIDERS = {
  codex: { name: 'OpenAI', product: 'Codex CLI' },
  claude: { name: 'Anthropic', product: 'Claude Code' },
} as const;

interface ProviderConnectionCardsProps {
  readonly providerIds?: readonly ProviderConnectionId[];
  readonly advanced?: Partial<Record<ProviderConnectionId, ReactNode>>;
  readonly onStatus?: (providerId: ProviderConnectionId, status: ProviderConnectionStatus) => void;
  readonly compact?: boolean;
  readonly executableOverrides?: Partial<Record<ProviderConnectionId, string>>;
}

export function ProviderConnectionCards({
  providerIds = ['codex', 'claude'],
  advanced,
  onStatus,
  compact = false,
  executableOverrides = {},
}: ProviderConnectionCardsProps) {
  const { views, perform, cancel } = useProviderConnections(providerIds, executableOverrides);

  useEffect(() => {
    for (const providerId of providerIds) {
      const status = views[providerId]?.status;
      if (status) onStatus?.(providerId, status);
    }
  }, [onStatus, providerIds.join('|'), views]);

  return (
    <div className={compact ? 'provider-connections compact' : 'provider-connections'}>
      {providerIds.map((providerId) => {
        const provider = PROVIDERS[providerId];
        const view = views[providerId];
        const status = view?.status ?? null;
        const active = view?.activeAction ?? null;
        const connected = status?.state === 'connected';
        const needsRefresh = status?.state === 'unknown';
        const reconnect = needsRefresh && status.checkedAt !== null;
        const statusLabel = view?.loading
          ? 'Checking'
          : connected
            ? 'Connected'
            : needsRefresh
              ? 'Needs refresh'
              : 'Not connected';

        return (
          <article
            className="provider-connection-card"
            key={providerId}
            aria-busy={Boolean(active)}
          >
            <div className="provider-connection-heading">
              <div>
                <strong>{provider.product}</strong>
                <small>{provider.name} account</small>
              </div>
              <span
                className={connected ? 'status-chip ok' : 'status-chip'}
                role="status"
                aria-live="polite"
              >
                {view?.loading && <LoaderCircle className="spin" size={12} aria-hidden="true" />}
                {statusLabel}
              </span>
            </div>
            <p>
              {active === 'connect'
                ? `Waiting for ${provider.name} sign-in to finish…`
                : active === 'disconnect'
                  ? 'Disconnecting this local CLI account…'
                  : (status?.reason ??
                    `${provider.name} owns the browser sign-in. Forgeboard never sees or stores OAuth tokens.`)}
            </p>
            <small className="provider-privacy-note">
              {provider.name} owns sign-in. Forgeboard never sees or stores OAuth tokens.
            </small>
            {view?.error && (
              <p className="provider-connection-error" role="alert">
                {view.error}
              </p>
            )}
            <div className="provider-connection-actions">
              {active ? (
                <button type="button" onClick={() => void cancel(providerId)}>
                  {active === 'connect' ? 'Cancel sign-in' : 'Cancel operation'}
                </button>
              ) : connected ? (
                <button type="button" onClick={() => void perform(providerId, 'disconnect')}>
                  Disconnect
                </button>
              ) : (
                <button type="button" onClick={() => void perform(providerId, 'connect')}>
                  {reconnect ? 'Reconnect' : `Connect with ${provider.name}`}
                </button>
              )}
              <button
                type="button"
                disabled={Boolean(active || view?.loading)}
                onClick={() => void perform(providerId, 'refresh')}
              >
                Refresh
              </button>
              {!connected && !active && (
                <span className="provider-browser-note">
                  <ExternalLink size={12} aria-hidden="true" /> Official sign-in opens in your
                  browser
                </span>
              )}
            </div>
            {advanced?.[providerId] && (
              <details className="provider-connection-advanced">
                <summary>Advanced</summary>
                <p>Optional executable, model, and readiness overrides.</p>
                {advanced[providerId]}
              </details>
            )}
          </article>
        );
      })}
    </div>
  );
}
