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
      onError(cause instanceof Error ? cause.message : 'Agent readiness could not be checked.');
    }
  }

  return (
    <section className={`agent-readiness ${ready ? 'ready' : 'attention'}`} aria-live="polite">
      <header>
        <span>
          {ready ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <strong>
            {ready ? `${statusSubject} is ready` : `${statusSubject} needs attention`}
          </strong>
        </span>
        <button
          type="button"
          disabled={disabled || checking || checkReadiness === undefined || draft.request === null}
          onClick={() => void refresh()}
          aria-label={`Refresh ${label} readiness`}
        >
          <RefreshCw className={checking ? 'spin' : ''} size={13} />
          {checking ? 'Checking…' : 'Refresh readiness'}
        </button>
      </header>

      {draft.issue !== null ? (
        <p role="alert">{draft.issue}</p>
      ) : result !== null ? (
        <ReadinessResult result={result} />
      ) : launchReady ? (
        <p>
          Detected and versioned when Forgeboard opened: <code>{agent?.version}</code>. Refresh to
          revalidate the current executable without saving this draft.
        </p>
      ) : (
        <p>
          {agent?.installed
            ? 'The executable was located, but its version has not been validated.'
            : 'No usable executable is currently detected. Browse to one or install the CLI, then refresh.'}
        </p>
      )}
      {!ready && <p>{agentDependencyGuidance(agent, draft.request?.agentId ?? 'custom')}</p>}
      {checkReadiness === undefined && (
        <p className="agent-readiness-unavailable" role="status">
          Readiness refresh is unavailable in this application build. Only launch-time detection
          evidence can be shown until the readiness bridge is available.
        </p>
      )}
      <small>
        The check runs the adapter's bounded version and capability probes against the current UI
        draft. It does not save the draft or launch an agent run.
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
        Validated <code>{result.version}</code> from{' '}
        {result.source === 'override' ? 'the selected override' : result.source}.
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
