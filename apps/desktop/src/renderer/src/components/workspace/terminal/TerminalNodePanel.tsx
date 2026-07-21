import {
  CircleAlert,
  Eraser,
  FolderSearch,
  History,
  Keyboard,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Square,
  TerminalSquare,
} from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

import {
  TerminalArgumentsSchema,
  TerminalEnvironmentVariableNamesSchema,
  TerminalExecutableSchema,
  TerminalRelativeCwdSchema,
  type TerminalSessionStatus,
  type TerminalSessionView,
} from '../../../../../shared/terminal/index.js';
import { EnvironmentAllowlistEditor } from '../../configuration/EnvironmentAllowlistEditor.js';
import { TerminalLaunchReviewDialog } from './TerminalLaunchReviewDialog.js';
import { WorkspaceTooltip } from '../shell/tooltips/WorkspaceTooltip.js';
import { TerminalSurface, type TerminalSurfaceHandle } from './TerminalSurface.js';
import {
  terminalOperationsFromWindow,
  type TerminalNodeConfiguration,
  type TerminalOperations,
} from './types.js';
import { useTerminalNodeController } from './useTerminalNodeController.js';
import './terminal-node.css';

export interface TerminalNodePanelProps {
  readonly projectId: string;
  readonly nodeId: string;
  readonly locked: boolean;
  readonly configurationReadOnly: boolean;
  readonly configuration: TerminalNodeConfiguration;
  readonly onRecord: () => void;
  readonly onConfigurationChange: (configuration: TerminalNodeConfiguration) => void;
  readonly onSessionChange?: ((session: TerminalSessionView | null) => void) | undefined;
  readonly onError: (message: string) => void;
  readonly operations?: TerminalOperations | undefined;
}

export function TerminalNodePanel({
  operations: injectedOperations,
  ...props
}: TerminalNodePanelProps) {
  const operations = useMemo(
    () => injectedOperations ?? terminalOperationsFromWindow(),
    [injectedOperations],
  );
  const controller = useTerminalNodeController({
    projectId: props.projectId,
    nodeId: props.nodeId,
    configuration: props.configuration,
    onError: props.onError,
    onSessionChange: props.onSessionChange,
    operations,
  });
  const surfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  const [search, setSearch] = useState('');
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const effectsReadOnly = props.locked || props.configurationReadOnly;
  const mutationBusy = controller.busy !== null || controller.pendingPlan !== null;
  const configurationIssues = useMemo(
    () => terminalConfigurationIssues(props.configuration),
    [props.configuration],
  );
  const canLaunch =
    !effectsReadOnly && !controller.active && !mutationBusy && configurationIssues.length === 0;
  const status = controller.session?.status ?? 'idle';

  const updateConfiguration = (patch: Partial<TerminalNodeConfiguration>): void => {
    props.onRecord();
    props.onConfigurationChange({ ...props.configuration, ...patch });
  };

  const findNext = (): void => {
    if (search.trim() === '') {
      setSearchNotice('Type something to search for.');
      return;
    }
    const found = surfaceRef.current?.findNext(search) ?? false;
    setSearchNotice(found ? `Found the next match for “${search}”.` : `No match for “${search}”.`);
  };

  const stopInspectorEnter = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter') event.stopPropagation();
  };

  return (
    <section
      className="terminal-node-panel"
      aria-label="Terminal"
      aria-busy={controller.busy !== null}
      onKeyDown={stopInspectorEnter}
    >
      <header className="terminal-node-header">
        <span>
          <TerminalSquare size={15} aria-hidden="true" />
          <strong>Terminal</strong>
        </span>
        <span className={`terminal-status ${status}`} role="status" aria-live="polite">
          {controller.busy === 'loading' ? 'Loading…' : terminalStatusLabel(status)}
        </span>
      </header>

      {props.configurationReadOnly ? (
        <p className="terminal-state warning" role="status">
          <ShieldAlert size={14} aria-hidden="true" />
          Your role can view this terminal, but not start, type, resize, or change it. Interrupt and
          Terminate stay available so you can stop a process that is already running.
        </p>
      ) : props.locked ? (
        <p className="terminal-state warning" role="status">
          <ShieldAlert size={14} aria-hidden="true" />
          Unlock this node to change settings, type, or start a process. Interrupt and Terminate
          stay available until the process exits or the session is lost.
        </p>
      ) : null}

      <fieldset
        className="terminal-configuration"
        disabled={effectsReadOnly || controller.active || mutationBusy}
      >
        <legend>Command to run</legend>
        <div className="terminal-configuration-field">
          <label htmlFor={`node-${props.nodeId}-terminal-executable`}>Program</label>
          <div className="terminal-executable-field">
            <input
              id={`node-${props.nodeId}-terminal-executable`}
              name={`node-${props.nodeId}-terminal-executable`}
              value={props.configuration.executable}
              autoComplete="off"
              spellCheck={false}
              placeholder="Choose a program on this computer…"
              aria-invalid={
                !TerminalExecutableSchema.safeParse(props.configuration.executable).success
              }
              onChange={(event) => updateConfiguration({ executable: event.target.value })}
            />
            <button
              type="button"
              disabled={controller.busy !== null}
              onClick={() => {
                void controller.chooseExecutable().then((executable) => {
                  if (executable !== null) updateConfiguration({ executable });
                });
              }}
            >
              <FolderSearch size={13} aria-hidden="true" />
              {controller.busy === 'choosing-executable' ? 'Choosing…' : 'Browse'}
            </button>
          </div>
          <small>
            Browse for a program or type its full path. It runs exactly as written — never through a
            shell.
          </small>
        </div>

        <fieldset className="terminal-arguments">
          <legend>Arguments</legend>
          {props.configuration.arguments.length === 0 ? <small>No arguments yet.</small> : null}
          {props.configuration.arguments.map((argument, index) => (
            <div key={index} className="terminal-argument-row">
              <label>
                <span className="sr-only">Argument {index + 1}</span>
                <input
                  name={`node-${props.nodeId}-terminal-argument-${index}`}
                  value={argument}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`Argument ${index + 1}`}
                  onChange={(event) => {
                    const arguments_ = [...props.configuration.arguments];
                    arguments_[index] = event.target.value;
                    updateConfiguration({ arguments: arguments_ });
                  }}
                />
              </label>
              <button
                type="button"
                aria-label={`Remove argument ${index + 1}`}
                onClick={() =>
                  updateConfiguration({
                    arguments: props.configuration.arguments.filter((_, item) => item !== index),
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="terminal-add-argument"
            disabled={props.configuration.arguments.length >= 512}
            onClick={() =>
              updateConfiguration({
                arguments: [...props.configuration.arguments, ''],
              })
            }
          >
            Add argument
          </button>
        </fieldset>

        <div className="terminal-configuration-field">
          <label htmlFor={`node-${props.nodeId}-terminal-cwd`}>Folder to run in</label>
          <input
            id={`node-${props.nodeId}-terminal-cwd`}
            name={`node-${props.nodeId}-terminal-cwd`}
            value={props.configuration.cwdRelative}
            autoComplete="off"
            spellCheck={false}
            placeholder="."
            aria-invalid={
              !TerminalRelativeCwdSchema.safeParse(props.configuration.cwdRelative).success
            }
            onChange={(event) => updateConfiguration({ cwdRelative: event.target.value })}
          />
          <small>
            Use <code>.</code> for the project folder, or one inside it like{' '}
            <code>apps/desktop</code>. Folders outside the project aren&apos;t allowed.
          </small>
        </div>

        <EnvironmentAllowlistEditor
          name={`node-${props.nodeId}-terminal-environment`}
          value={props.configuration.environmentVariableNames}
          compact
          onChange={(environmentVariableNames) => updateConfiguration({ environmentVariableNames })}
        />
        {configurationIssues.length > 0 ? (
          <ul className="terminal-configuration-errors" role="alert">
            {configurationIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      <div className="terminal-toolbar" aria-label="Terminal controls">
        <WorkspaceTooltip content={configurationIssues[0] ?? 'Review the terminal launch'}>
          <button
            type="button"
            className="button primary"
            aria-label={controller.session === null ? 'Review and start' : 'Review and restart'}
            disabled={!canLaunch}
            onClick={() => void controller.prepareLaunch()}
          >
            {controller.busy === 'preparing' ? (
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
            ) : controller.session === null ? (
              <Play size={13} aria-hidden="true" />
            ) : (
              <RotateCcw size={13} aria-hidden="true" />
            )}
            {controller.busy === 'preparing'
              ? 'Preparing…'
              : controller.session === null
                ? 'Review and start'
                : 'Review and restart'}
          </button>
        </WorkspaceTooltip>
        {controller.active ? (
          <>
            <button
              type="button"
              disabled={controller.busy !== null}
              onClick={() => void controller.interrupt()}
            >
              <Keyboard size={13} aria-hidden="true" />
              {controller.busy === 'interrupting' ? 'Interrupting…' : 'Interrupt'}
            </button>
            <button
              type="button"
              className="danger-text"
              disabled={controller.busy !== null && controller.busy !== 'interrupting'}
              onClick={() => void controller.terminate()}
            >
              <Square size={13} aria-hidden="true" />
              {controller.busy === 'terminating' ? 'Terminating…' : 'Terminate'}
            </button>
          </>
        ) : null}
        <button
          type="button"
          disabled={controller.busy !== null}
          onClick={() => void controller.refresh()}
        >
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </button>
      </div>

      <div className="terminal-session-picker">
        <label>
          <History size={13} aria-hidden="true" /> Recent sessions
          <select
            name={`node-${props.nodeId}-terminal-session`}
            value={controller.session?.id ?? ''}
            disabled={
              controller.sessions.length === 0 || controller.active || controller.busy !== null
            }
            onChange={(event) => void controller.selectSession(event.target.value)}
          >
            {controller.sessions.length === 0 ? <option value="">No sessions yet</option> : null}
            {controller.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {sessionOptionLabel(session)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="terminal-runtime" aria-label="Terminal output and input">
        <div className="terminal-search-row">
          <label>
            <span className="sr-only">Search terminal output</span>
            <Search size={13} aria-hidden="true" />
            <input
              name={`node-${props.nodeId}-terminal-search`}
              value={search}
              placeholder="Search terminal output"
              aria-label="Search terminal output"
              onChange={(event) => {
                setSearch(event.target.value);
                setSearchNotice(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  findNext();
                }
              }}
            />
          </label>
          <button type="button" disabled={search.trim() === ''} onClick={findNext}>
            Find next
          </button>
          <button
            type="button"
            onClick={() => {
              surfaceRef.current?.clearDisplay();
              setSearchNotice('Display cleared — the saved output is still kept.');
            }}
          >
            <Eraser size={13} aria-hidden="true" /> Clear display
          </button>
        </div>
        {searchNotice !== null ? (
          <small className="terminal-search-notice" role="status" aria-live="polite">
            {searchNotice}
          </small>
        ) : null}
        <div className="terminal-surface-frame">
          <TerminalSurface
            ref={surfaceRef}
            sessionId={controller.session?.id ?? null}
            output={controller.output}
            inputEnabled={controller.active && !effectsReadOnly && controller.busy === null}
            onInput={(data) => controller.sendInput(data)}
            onResize={(columns, rows) => controller.resize(columns, rows)}
          />
          {controller.session === null ? (
            <div className="terminal-empty-state">
              <TerminalSquare size={22} aria-hidden="true" />
              <strong>No terminal running</strong>
              <span>Pick a program above, then choose Review and start.</span>
            </div>
          ) : null}
        </div>
      </section>

      {controller.session !== null ? (
        <TerminalSessionEvidence
          session={controller.session}
          replayWindowLimited={controller.replayWindowLimited}
        />
      ) : (
        <p className="terminal-permission-summary">
          <ShieldAlert size={13} aria-hidden="true" />
          Programs here run with your full user permissions — the project folder doesn&apos;t limit
          what they can access.
        </p>
      )}

      {controller.notice !== null ? (
        <p className="terminal-state" role="status" aria-live="polite">
          {controller.notice}
        </p>
      ) : null}
      {controller.error !== null ? (
        <p className="terminal-state error" role="alert">
          <CircleAlert size={14} aria-hidden="true" /> {controller.error}
        </p>
      ) : null}

      {controller.pendingPlan !== null ? (
        <TerminalLaunchReviewDialog
          plan={controller.pendingPlan}
          busy={controller.busy === 'confirming' || controller.busy === 'cancelling-plan'}
          onCancel={() => void controller.cancelLaunch()}
          onContinue={() => void controller.confirmLaunch()}
        />
      ) : null}
    </section>
  );
}

function TerminalSessionEvidence({
  session,
  replayWindowLimited,
}: {
  readonly session: TerminalSessionView;
  readonly replayWindowLimited: boolean;
}) {
  return (
    <section className="terminal-session-evidence" aria-label="Session details">
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{terminalStatusLabel(session.status)}</dd>
        </div>
        <div>
          <dt>Folder it runs in</dt>
          <dd>
            <code>{session.cwdRelative}</code> inside the project
          </dd>
        </div>
        <div>
          <dt>Window size</dt>
          <dd>
            {session.columns} × {session.rows}
          </dd>
        </div>
        {session.exitCode !== null ? (
          <div>
            <dt>Exit code</dt>
            <dd>{session.exitCode}</dd>
          </div>
        ) : null}
        {session.exitSignal !== null ? (
          <div>
            <dt>Exit signal</dt>
            <dd>{session.exitSignal}</dd>
          </div>
        ) : null}
      </dl>
      <div className="terminal-permission-summary">
        <ShieldAlert size={13} aria-hidden="true" />
        <span>
          <strong>{session.permission.label}.</strong> {session.permission.detail}
        </span>
      </div>
      {session.status === 'lost' ? (
        <p className="terminal-state error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          Forgeboard lost track of this process. You can read the output, but not type or use the
          controls. Start a new session to run it again.
        </p>
      ) : null}
      {replayWindowLimited ? (
        <p className="terminal-state warning" role="status">
          Only the most recent output is shown — earlier output was trimmed.
        </p>
      ) : null}
    </section>
  );
}

function terminalConfigurationIssues(configuration: TerminalNodeConfiguration): string[] {
  const issues: string[] = [];
  const executable = TerminalExecutableSchema.safeParse(configuration.executable);
  if (!executable.success)
    issues.push(executable.error.issues[0]?.message ?? 'Choose a program to run.');
  const arguments_ = TerminalArgumentsSchema.safeParse(configuration.arguments);
  if (!arguments_.success) {
    issues.push(arguments_.error.issues[0]?.message ?? 'Review the arguments.');
  }
  const cwd = TerminalRelativeCwdSchema.safeParse(configuration.cwdRelative);
  if (!cwd.success) {
    issues.push(cwd.error.issues[0]?.message ?? 'Choose a folder inside the project.');
  }
  const environment = TerminalEnvironmentVariableNamesSchema.safeParse(
    configuration.environmentVariableNames,
  );
  if (!environment.success) {
    issues.push(environment.error.issues[0]?.message ?? 'Review the environment variable names.');
  }
  return [...new Set(issues)];
}

function terminalStatusLabel(status: TerminalSessionStatus | 'idle'): string {
  return {
    idle: 'Idle',
    starting: 'Starting',
    running: 'Running',
    exited: 'Finished',
    failed: 'Failed',
    interrupted: 'Interrupted',
    terminated: 'Terminated',
    lost: 'Lost after restart',
  }[status];
}

function sessionOptionLabel(session: TerminalSessionView): string {
  const timestamp = session.startedAt ?? session.updatedAt;
  const executable = session.executable.split(/[\\/]/u).at(-1) ?? session.executable;
  return `${executable} · ${terminalStatusLabel(session.status)} · ${new Date(timestamp).toLocaleString()}`;
}
