import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';

import type { AgentDetection } from '../../../../shared/application/contracts.js';
import type {
  AgentReadinessResult,
  CheckAgentReadiness,
} from '../../../../shared/readiness/contracts.js';
import type { AgentReadinessDraft } from './readiness-ui.js';
import { launchDetectionIsReady } from './readiness-ui.js';
import { agentDependencyGuidance } from '../configuration/dependency-guidance.js';
import './AgentReadinessPanel.css';

interface AgentReadinessPanelProps {
  readonly agent: AgentDetection | undefined;
  readonly agentLabel?: string;
  readonly statusSubject?: string;
  readonly draft: AgentReadinessDraft;
  readonly result: AgentReadinessResult | null;
  readonly checking: boolean;
  readonly disabled?: boolean;
  readonly launchDetectionReady?: boolean;
  readonly checkReadiness: CheckAgentReadiness | undefined;
  readonly onResult: (result: AgentReadinessResult) => void;
  readonly onError: (message: string) => void;
}

export function AgentReadinessPanel({
  agent,
  agentLabel,
  statusSubject = 'Selected executable',
  draft,
  result,
  checking,
  disabled = false,
  launchDetectionReady,
  checkReadiness,
  onResult,
  onError,
}: AgentReadinessPanelProps) {
  const launchReady = launchDetectionReady ?? launchDetectionIsReady(agent, draft);
  const ready = result?.ready === true || (result === null && launchReady);
  const label = agentLabel ?? agent?.label ?? draft.request?.agentId ?? 'selected agent';

  async function refresh(): Promise<void> {
    if (checkReadiness === undefined || draft.request === null) return;
    try {
      const refreshed = await checkReadiness(draft.request);
      if (refreshed !== null) onResult(refreshed);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'Forgeboard could not check this agent. Try again.',
      );
    }
  }

  return (
    <section className={`agent-readiness ${ready ? 'ready' : 'attention'}`}>
      <header>
        <span>
          {ready ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <AlertTriangle size={15} aria-hidden="true" />
          )}
          <strong>
            {ready ? `${statusSubject} is ready` : `${statusSubject} needs attention`}
          </strong>
        </span>
        <button
          type="button"
          disabled={disabled || checking || checkReadiness === undefined || draft.request === null}
          onClick={() => void refresh()}
          aria-label={`Check ${label} again`}
        >
          <RefreshCw className={checking ? 'spin' : ''} size={13} aria-hidden="true" />
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </header>

      <div aria-live="polite">
        {draft.issue !== null ? (
          <p role="alert">{draft.issue}</p>
        ) : result !== null ? (
          <ReadinessResult result={result} />
        ) : launchReady ? (
          <p>
            Found when Forgeboard opened: version <code>{agent?.version}</code>. “Check again”
            re-checks the current program — nothing is saved.
          </p>
        ) : (
          <p>
            {agent?.installed
              ? 'The program was found, but its version has not been checked yet.'
              : 'No usable program was found. Use Browse to find it, or install the tool and then check again.'}
          </p>
        )}
      </div>
      {!ready && <p>{agentDependencyGuidance(agent, draft.request?.agentId ?? 'custom')}</p>}
      {checkReadiness === undefined && (
        <p className="agent-readiness-unavailable" role="status">
          Re-checking is not available in this build of Forgeboard. Only what was found when the app
          opened can be shown.
        </p>
      )}
      <small>
        Asks the agent for its version using your current, unsaved settings. Nothing is saved and no
        run starts.
      </small>
    </section>
  );
}

function ReadinessResult({ result }: { readonly result: AgentReadinessResult }) {
  if (!result.ready) {
    return (
      <div className="agent-readiness-result">
        <p role="alert">{result.reason}</p>
        {result.executable !== null && <code>{result.executable}</code>}
      </div>
    );
  }
  return (
    <div className="agent-readiness-result">
      <p>
        Version <code>{result.version}</code> confirmed from{' '}
        {result.source === 'override' ? 'the program you selected' : result.source}.
      </p>
      <code>{result.executable}</code>
      {result.warnings.map((warning) => (
        <p className="agent-readiness-warning" key={warning}>
          {warning}
        </p>
      ))}
    </div>
  );
}
