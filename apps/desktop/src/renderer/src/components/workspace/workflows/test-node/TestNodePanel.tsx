import { CircleStop, ExternalLink, FolderOpen, Play, RefreshCw, TestTube2 } from 'lucide-react';

import { normalizedCommand } from '../workflow-node-config.js';
import { TestNodeConfiguration } from './TestNodeConfiguration.js';
import type { TestNodeArtifact, TestNodePanelProps } from './contracts.js';
import { testNodeAttempts, testStatusLabel, type TestNodeAttemptView } from './view-model.js';
import './test-node-panel.css';

export function TestNodePanel(props: TestNodePanelProps) {
  const attempts = testNodeAttempts(props.node.id, props.executions, props.interactionEvents);
  const current = attempts[0] ?? null;
  const commandConfigured = normalizedCommand(props.node).executable.trim() !== '';
  const operationBusy = props.busyAction !== null;
  const canStart =
    !props.locked && !props.configurationReadOnly && !operationBusy && !current?.active;
  const artifacts = (current?.artifacts ?? []).filter(
    (artifact) => artifact.nodeId === props.node.id && artifact.projectId === props.projectId,
  );

  return (
    <section className="test-node-panel" aria-label="Test node">
      <header>
        <div>
          <TestTube2 size={14} aria-hidden="true" />
          <h3>Test runner</h3>
        </div>
        <span className={`test-node-state ${current?.status ?? 'not-run'}`} role="status">
          {current === null ? 'Not run' : testStatusLabel(current)}
        </span>
      </header>

      <TestNodeConfiguration {...props} />
      <p className="test-node-safety">
        Forgeboard runs this exact executable and literal arguments without a shell. Launch still
        requires native review of the resolved checkout and environment names.
      </p>
      <div className="test-node-actions">
        {current?.active ? (
          <button
            type="button"
            disabled={operationBusy || !props.mutationsAuthorized}
            onClick={() =>
              props.onCancel({
                executionId: current.executionId,
                nodeId: props.node.id,
                attempt: current.attempt,
              })
            }
          >
            <CircleStop size={12} aria-hidden="true" />
            {operationBusy ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : (
          <button
            type="button"
            disabled={!canStart || !commandConfigured}
            onClick={() => props.onStart(props.node.id)}
          >
            {current === null ? (
              <Play size={12} aria-hidden="true" />
            ) : (
              <RefreshCw size={12} aria-hidden="true" />
            )}
            {current === null ? 'Review & run' : 'Run again'}
          </button>
        )}
      </div>

      {!commandConfigured && (
        <p className="test-node-recovery" role="alert">
          Configure an executable in this panel before running the Test node.
        </p>
      )}
      {!props.mutationsAuthorized && (
        <p className="test-node-recovery" role="status">
          This collaboration role can inspect Test history but cannot run or cancel checks.
        </p>
      )}
      {current?.approvalRequired && (
        <p className="test-node-recovery" role="status">
          Launch review is waiting in the Workflows activity panel. No process has started.
        </p>
      )}
      {current?.status === 'lost' && (
        <p className="test-node-recovery" role="alert">
          Forgeboard lost the previous process during recovery. Review the retained attempt, then
          run again when ready.
        </p>
      )}
      {current?.statusReason && <p className="test-node-recovery">{current.statusReason}</p>}

      {current && <AttemptResult attempt={current} title="Latest attempt" />}
      <ArtifactList
        artifacts={artifacts}
        checkExecutionId={current?.checkExecutionId}
        onReveal={props.onRevealArtifact}
        onOpen={props.onOpenArtifact}
        onError={props.onError}
      />
      <AttemptHistory
        attempts={attempts.slice(1)}
        projectId={props.projectId}
        onReveal={props.onRevealArtifact}
        onOpen={props.onOpenArtifact}
        onError={props.onError}
      />
    </section>
  );
}

function AttemptResult({
  attempt,
  title,
}: {
  readonly attempt: TestNodeAttemptView;
  readonly title: string;
}) {
  return (
    <section className="test-node-result" aria-label="Latest test attempt">
      <header>
        <strong>{title}</strong>
        <small>Attempt {attempt.attempt}</small>
      </header>
      {attempt.summary && (
        <dl className="test-node-summary" aria-label="Parsed test summary">
          <div>
            <dt>Passed</dt>
            <dd>{attempt.summary.passed}</dd>
          </div>
          <div>
            <dt>Failed</dt>
            <dd>{attempt.summary.failed}</dd>
          </div>
          <div>
            <dt>Skipped</dt>
            <dd>{attempt.summary.skipped}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{attempt.summary.total}</dd>
          </div>
        </dl>
      )}
      {attempt.output === '' ? (
        <p className="test-node-empty">
          {attempt.active
            ? 'Waiting for process output…'
            : 'Raw output is unavailable in this session.'}
        </p>
      ) : (
        <pre tabIndex={0} aria-label="Test node raw output">
          {attempt.output}
        </pre>
      )}
      {attempt.outputTruncated && (
        <small>Output was truncated at the trusted runtime boundary.</small>
      )}
    </section>
  );
}

function ArtifactList({
  artifacts,
  checkExecutionId,
  onReveal,
  onOpen,
  onError,
}: {
  readonly artifacts: readonly TestNodeArtifact[];
  readonly checkExecutionId: string | undefined;
  readonly onReveal: TestNodePanelProps['onRevealArtifact'];
  readonly onOpen: TestNodePanelProps['onOpenArtifact'];
  readonly onError: (message: string) => void;
}) {
  if (artifacts.length === 0 || checkExecutionId === undefined) return null;
  const invoke = async (
    action: TestNodePanelProps['onRevealArtifact'],
    artifact: TestNodeArtifact,
  ) => {
    try {
      await action({
        checkExecutionId,
        executionId: artifact.executionId,
        nodeId: artifact.nodeId,
        attempt: artifact.attempt,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'The test artifact could not be opened.');
    }
  };
  return (
    <section className="test-node-artifacts" aria-label="Verified test artifacts">
      <strong>Verified artifacts</strong>
      {artifacts.map((artifact) => (
        <article key={`${artifact.executionId}:${artifact.attempt}:${artifact.relativePath}`}>
          <code>{artifact.relativePath}</code>
          <span>
            <button type="button" onClick={() => void invoke(onReveal, artifact)}>
              <FolderOpen size={11} aria-hidden="true" /> Reveal {artifact.label}
            </button>
            <button type="button" onClick={() => void invoke(onOpen, artifact)}>
              <ExternalLink size={11} aria-hidden="true" /> Open {artifact.label}
            </button>
          </span>
        </article>
      ))}
    </section>
  );
}

function AttemptHistory({
  attempts,
  projectId,
  onReveal,
  onOpen,
  onError,
}: {
  readonly attempts: readonly TestNodeAttemptView[];
  readonly projectId: string;
  readonly onReveal: TestNodePanelProps['onRevealArtifact'];
  readonly onOpen: TestNodePanelProps['onOpenArtifact'];
  readonly onError: (message: string) => void;
}) {
  if (attempts.length === 0) return null;
  return (
    <section className="test-node-history" aria-label="Previous test attempts">
      <strong>Previous attempts</strong>
      <ol>
        {attempts.slice(0, 10).map((attempt) => {
          const artifacts = attempt.artifacts.filter(
            (artifact) => artifact.projectId === projectId,
          );
          return (
            <li key={`${attempt.executionId}:${String(attempt.attempt)}`}>
              <details>
                <summary>
                  <span>
                    Attempt {attempt.attempt} · {testStatusLabel(attempt)}
                  </span>
                  <time dateTime={attempt.updatedAt}>
                    {new Date(attempt.updatedAt).toLocaleString()}
                  </time>
                </summary>
                <AttemptResult attempt={attempt} title="Retained result" />
                <ArtifactList
                  artifacts={artifacts}
                  checkExecutionId={attempt.checkExecutionId}
                  onReveal={onReveal}
                  onOpen={onOpen}
                  onError={onError}
                />
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
