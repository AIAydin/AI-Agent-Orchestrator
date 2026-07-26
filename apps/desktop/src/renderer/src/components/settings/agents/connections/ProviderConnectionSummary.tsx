import type { ProviderConnectionId } from '../../../../../../shared/provider-connections/index.js';
import { useProviderConnections } from './useProviderConnections.js';

const LABELS: Record<ProviderConnectionId, string> = {
  codex: 'OpenAI Codex CLI',
  claude: 'Anthropic Claude Code',
};

export function ProviderConnectionSummary() {
  const providerIds: readonly ProviderConnectionId[] = ['codex', 'claude'];
  const { views } = useProviderConnections(providerIds);

  return (
    <>
      {providerIds.map((providerId) => {
        const view = views[providerId];
        const state = view?.status?.state;
        return (
          <div key={providerId}>
            <span>
              <strong>{LABELS[providerId]}</strong>
              <small>
                {view?.status?.reason ??
                  'Provider-owned OAuth; Artemis never sees or stores tokens.'}{' '}
                Manage in Settings → Agents.
              </small>
            </span>
            <span className={state === 'connected' ? 'status-chip ok' : 'status-chip'}>
              {view?.loading
                ? 'Checking'
                : state === 'connected'
                  ? 'Connected'
                  : state === 'unknown'
                    ? 'Needs attention'
                    : 'Not connected'}
            </span>
          </div>
        );
      })}
    </>
  );
}
