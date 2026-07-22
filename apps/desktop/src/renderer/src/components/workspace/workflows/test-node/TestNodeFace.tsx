import { useState, type JSX } from 'react';
import {
  CircleStop,
  ExternalLink,
  FolderOpen,
  Play,
  RefreshCw,
  Settings2,
  TestTube2,
} from 'lucide-react';

import { unwrap } from '../../../../lib/ipc.js';
import { LITERAL_ARGUMENT_HELP, parseLiteralArguments } from '../../../../lib/literal-arguments.js';
import type { WorkshopCommandConfiguration, WorkshopNode } from '../../canvas/CanvasNode.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import {
  checkProducerIdFor,
  commandPresets,
  normalizedCommandFor,
  parseLineList,
  producerIdForCheckKind,
} from '../workflow-node-config.js';
import { useWorkflowRuntime } from '../WorkflowRuntimeContext.js';
import type { TestNodeArtifact } from './contracts.js';
import { testNodeAttempts, testStatusLabel, type TestNodeAttemptView } from './view-model.js';

/**
 * Test-runner face: command summary, run status, Start/Cancel, latest-attempt
 * summary and verified artifacts, the full output/history view, and the command
 * configuration inside a node-anchored config popover.
 */
export function TestNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const runtime = useWorkflowRuntime();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const attempts = testNodeAttempts(id, runtime.executions, runtime.interactionEvents);
  const current = attempts[0] ?? null;
  const history = attempts.slice(1);
  const command = normalizedCommandFor(data);
  const commandLine = [command.executable, ...command.arguments].join(' ').trim();
  const commandConfigured = command.executable.trim() !== '';
  const operationBusy = runtime.busyAction !== null;
  const canStart =
    !readOnly &&
    !operationBusy &&
    current?.active !== true &&
    commandConfigured &&
    runtime.mutationsAuthorized;
  const artifacts = (current?.artifacts ?? []).filter(
    (artifact) => artifact.nodeId === id && artifact.projectId === session.project.id,
  );
  const [configuring, setConfiguring] = useState(false);
  const presets = configuring ? commandPresets(session.settings) : [];

  const updateCommand = (next: WorkshopCommandConfiguration): void =>
    session.updateNodeData(id, { command: next });

  const browseExecutable = async (): Promise<void> => {
    try {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected === null) return;
      session.recordHistory();
      updateCommand({ ...command, executable: selected });
    } catch (cause) {
      session.reportError(
        cause instanceof Error ? cause.message : 'The program could not be selected.',
      );
    }
  };

  const invokeArtifact = async (
    action: (input: Parameters<typeof runtime.revealArtifact>[0]) => Promise<void>,
    artifact: TestNodeArtifact,
    checkExecutionId: string | undefined,
  ): Promise<void> => {
    if (checkExecutionId === undefined) return;
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
      session.reportError(
        cause instanceof Error ? cause.message : 'The test artifact could not be opened.',
      );
    }
  };

  return (
    <section className="node-face test-node-face" aria-label="Test runner">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <TestTube2 size={12} aria-hidden="true" /> Test runner
        </span>
        <span
          className={`node-face-status ${current?.status === 'failed' ? 'failed' : ''}`}
          role="status"
        >
          {current === null ? 'Not run' : testStatusLabel(current)}
        </span>
        <button
          type="button"
          aria-label="Configure test command"
          aria-pressed={configuring}
          onClick={() => setConfiguring((open) => !open)}
        >
          <Settings2 size={12} aria-hidden="true" /> Configure
        </button>
      </div>
      <div className="node-face-body nowheel nodrag">
        {commandConfigured ? (
          <code className="test-face-command">{commandLine}</code>
        ) : (
          <p role="alert" className="test-face-warning">
            Set up a command in Configure before running this test.
          </p>
        )}

        <div className="node-face-row">
          {current?.active === true ? (
            <button
              type="button"
              aria-label="Cancel"
              disabled={operationBusy || !runtime.mutationsAuthorized}
              onClick={() =>
                runtime.cancelNode({
                  executionId: current.executionId,
                  nodeId: id,
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
              aria-label="Review and run"
              disabled={!canStart}
              onClick={() => runtime.startNode(id)}
            >
              {current === null ? (
                <Play size={12} aria-hidden="true" />
              ) : (
                <RefreshCw size={12} aria-hidden="true" />
              )}
              Review and run
            </button>
          )}
          <span className="node-face-status">
            {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
          </span>
        </div>

        {current?.summary !== null && current?.summary !== undefined ? (
          <p className="test-face-summary">
            {current.summary.passed} passed · {current.summary.failed} failed ·{' '}
            {current.summary.total} total
          </p>
        ) : null}
        {current?.approvalRequired === true ? (
          <p role="status" className="test-face-warning">
            Waiting for your approval in the Workflows panel.
          </p>
        ) : null}
        {current?.statusReason !== undefined ? (
          <p className="test-face-warning">{current.statusReason}</p>
        ) : null}

        {artifacts.length > 0 && current?.checkExecutionId !== undefined ? (
          <div className="test-face-artifacts" aria-label="Verified test artifacts">
            {artifacts.map((artifact) => (
              <div
                className="node-face-row"
                key={`${artifact.executionId}:${artifact.attempt}:${artifact.relativePath}`}
              >
                <code>{artifact.relativePath}</code>
                <button
                  type="button"
                  aria-label={`Reveal ${artifact.label}`}
                  onClick={() =>
                    void invokeArtifact(
                      (input) => runtime.revealArtifact(input),
                      artifact,
                      current.checkExecutionId,
                    )
                  }
                >
                  <FolderOpen size={11} aria-hidden="true" /> Reveal {artifact.label}
                </button>
                <button
                  type="button"
                  aria-label={`Open ${artifact.label}`}
                  onClick={() =>
                    void invokeArtifact(
                      (input) => runtime.openArtifact(input),
                      artifact,
                      current.checkExecutionId,
                    )
                  }
                >
                  <ExternalLink size={11} aria-hidden="true" /> Open {artifact.label}
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {current !== null ? <AttemptOutput attempt={current} /> : null}

        {history.length > 0 ? (
          <section className="test-face-history" aria-label="Previous test attempts">
            <div className="node-face-list-header">
              <strong>
                Previous attempts <span>{history.length}</span>
              </strong>
            </div>
            <ol className="test-face-history-list">
              {history.slice(0, 10).map((attempt) => (
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
                    {attempt.summary !== null ? (
                      <p className="test-face-summary">
                        {attempt.summary.passed} passed · {attempt.summary.failed} failed ·{' '}
                        {attempt.summary.total} total
                      </p>
                    ) : null}
                    <AttemptOutput attempt={attempt} />
                  </details>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {configuring ? (
          <fieldset
            className="node-face-popover test-face-config"
            disabled={readOnly}
            aria-label="Test command configuration"
          >
            <label>
              Saved command
              <select
                name={`node-${id}-face-command-preset`}
                aria-label="Saved command"
                value=""
                onChange={(event) => {
                  const selected = presets.find((preset) => preset.id === event.target.value);
                  if (selected === undefined) return;
                  session.recordHistory();
                  session.updateNodeData(id, {
                    command: selected.command,
                    checkKind: selected.kind,
                    runIds: [selected.id],
                  });
                }}
              >
                <option value="">Choose a saved command…</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kind of check
              <select
                name={`node-${id}-face-check-kind`}
                aria-label="Kind of check"
                value={data.checkKind ?? 'test'}
                onFocus={() => session.recordHistory()}
                onChange={(event) => {
                  const checkKind = event.target
                    .value as NonNullable<WorkshopNode['data']['checkKind']>;
                  session.updateNodeData(id, {
                    checkKind,
                    runIds: [producerIdForCheckKind(checkKind, data.runIds?.[0])],
                  });
                }}
              >
                <option value="lint">Lint</option>
                <option value="typecheck">Typecheck</option>
                <option value="test">Test</option>
                <option value="build">Build</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <div className="node-face-field">
              <span>Program</span>
              <span className="node-face-row">
                <input
                  name={`node-${id}-face-command-executable`}
                  aria-label="Program"
                  value={command.executable}
                  placeholder="pnpm"
                  onFocus={() => session.recordHistory()}
                  onChange={(event) =>
                    updateCommand({ ...command, executable: event.target.value })
                  }
                />
                <button type="button" onClick={() => void browseExecutable()}>
                  Browse
                </button>
              </span>
            </div>
            <label>
              Arguments <small>{LITERAL_ARGUMENT_HELP}</small>
              <textarea
                name={`node-${id}-face-command-arguments`}
                aria-label="Arguments"
                rows={3}
                value={command.arguments.join('\n')}
                placeholder={'run\ntest'}
                onFocus={() => session.recordHistory()}
                onChange={(event) =>
                  updateCommand({
                    ...command,
                    arguments: parseLiteralArguments(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Folder to run in · relative to the working copy
              <input
                name={`node-${id}-face-command-cwd`}
                aria-label="Folder to run in"
                value={command.cwdRelative ?? ''}
                placeholder="packages/app"
                onFocus={() => session.recordHistory()}
                onChange={(event) =>
                  updateCommand(withWorkingDirectory(command, event.target.value))
                }
              />
            </label>
            <label>
              Environment variables allowed · one per line
              <textarea
                name={`node-${id}-face-command-environment`}
                aria-label="Environment variables allowed"
                rows={2}
                value={(command.environmentNames ?? []).join('\n')}
                placeholder={'CI\nNODE_ENV'}
                onFocus={() => session.recordHistory()}
                onChange={(event) =>
                  updateCommand({
                    ...command,
                    environmentNames: parseLineList(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Result files to keep · one per line
              <textarea
                name={`node-${id}-face-artifact-paths`}
                aria-label="Result files to keep"
                rows={3}
                value={(data.artifactPaths ?? []).join('\n')}
                placeholder={'coverage/index.html\nreports/junit.xml'}
                onFocus={() => session.recordHistory()}
                onChange={(event) =>
                  session.updateNodeData(id, {
                    artifactPaths: parseLineList(event.target.value).slice(0, 32),
                  })
                }
              />
            </label>
            <small>
              Check ID: <code>{checkProducerIdFor(data, id)}</code>
            </small>
          </fieldset>
        ) : null}
      </div>
    </section>
  );
}

/** Read-only output of a single test attempt. */
function AttemptOutput({ attempt }: { readonly attempt: TestNodeAttemptView }): JSX.Element {
  if (attempt.output === '') {
    return (
      <p className="test-face-empty">
        {attempt.active ? 'Waiting for output…' : "Output isn't available in this session."}
      </p>
    );
  }
  return (
    <>
      <pre className="test-face-output" tabIndex={0} aria-label="Test output">
        {attempt.output}
      </pre>
      {attempt.outputTruncated ? (
        <small>Output was cut off because it reached the size limit.</small>
      ) : null}
    </>
  );
}

function withWorkingDirectory(
  command: WorkshopCommandConfiguration,
  value: string,
): WorkshopCommandConfiguration {
  const base: WorkshopCommandConfiguration = {
    executable: command.executable,
    arguments: command.arguments,
    ...(command.environmentNames === undefined
      ? {}
      : { environmentNames: command.environmentNames }),
  };
  return value.trim() === '' ? base : { ...base, cwdRelative: value };
}
