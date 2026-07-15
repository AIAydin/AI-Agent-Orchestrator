import { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  FileCode2,
  GitBranch,
  PanelBottomClose,
  ShieldCheck,
} from 'lucide-react';

import type { AuditEvent } from '../../../../shared/contracts.js';
import type { CheckExecutionView } from '../../../../shared/check-contracts.js';
import { unwrap } from '../../lib/ipc.js';
import type { ChangeReport, CheckCommand } from './types.js';
import { WorkspaceChecksPanel } from './WorkspaceChecksPanel.js';

type DrawerTab = 'activity' | 'changes' | 'checks' | 'audit';
const DRAWER_TABS: readonly DrawerTab[] = ['activity', 'changes', 'checks', 'audit'];

interface WorkspaceActivityDrawerProps {
  events: string[];
  changeReports: ChangeReport[];
  checkCommands: CheckCommand[];
  latestChecks: ReadonlyMap<string, CheckExecutionView>;
  busyCheckId: string | null;
  onPrepareCheck: (checkId: string) => void;
  onCancelCheck: (executionId: string) => void;
  onOpenSettings: () => void;
  onOpenGitReview: () => void;
  onClose: () => void;
}

export function WorkspaceActivityDrawer({
  events,
  changeReports,
  checkCommands,
  latestChecks,
  busyCheckId,
  onPrepareCheck,
  onCancelCheck,
  onOpenSettings,
  onOpenGitReview,
  onClose,
}: WorkspaceActivityDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>('activity');
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditState, setAuditState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [auditRefresh, setAuditRefresh] = useState(0);

  useEffect(() => {
    if (tab !== 'audit') return;
    let current = true;
    setAuditState('loading');
    void window.forgeboard.audit
      .list({ limit: 100 })
      .then((result) => {
        if (!current) return;
        setAuditEvents(unwrap(result));
        setAuditState('idle');
      })
      .catch(() => {
        if (current) setAuditState('error');
      });
    return () => {
      current = false;
    };
  }, [auditRefresh, tab]);

  return (
    <section className="activity-drawer">
      <header>
        <div className="activity-tabs" role="tablist" aria-label="Workspace details">
          <DrawerTabButton tab="activity" activeTab={tab} onSelect={setTab}>
            <Activity size={14} aria-hidden="true" /> Activity
          </DrawerTabButton>
          <DrawerTabButton tab="changes" activeTab={tab} onSelect={setTab}>
            <GitBranch size={14} aria-hidden="true" /> Changes
          </DrawerTabButton>
          <DrawerTabButton tab="checks" activeTab={tab} onSelect={setTab}>
            <CheckCircle2 size={14} aria-hidden="true" /> Checks
          </DrawerTabButton>
          <DrawerTabButton tab="audit" activeTab={tab} onSelect={setTab}>
            <ShieldCheck size={14} aria-hidden="true" /> Audit
          </DrawerTabButton>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close activity drawer"
        >
          <PanelBottomClose size={16} aria-hidden="true" />
        </button>
      </header>
      {tab === 'activity' && <ActivityPanel events={events} />}
      {tab === 'changes' && (
        <ChangesPanel reports={changeReports} onOpenGitReview={onOpenGitReview} />
      )}
      {tab === 'checks' && (
        <WorkspaceChecksPanel
          commands={checkCommands}
          latestByCheckId={latestChecks}
          busyCheckId={busyCheckId}
          onPrepare={onPrepareCheck}
          onCancel={onCancelCheck}
          onOpenSettings={onOpenSettings}
        />
      )}
      {tab === 'audit' && (
        <AuditPanel
          events={auditEvents}
          state={auditState}
          onRefresh={() => setAuditRefresh((value) => value + 1)}
        />
      )}
    </section>
  );
}

function DrawerTabButton({
  tab,
  activeTab,
  onSelect,
  children,
}: {
  tab: DrawerTab;
  activeTab: DrawerTab;
  onSelect: (tab: DrawerTab) => void;
  children: React.ReactNode;
}) {
  const selected = activeTab === tab;

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = DRAWER_TABS.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % DRAWER_TABS.length;
    if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + DRAWER_TABS.length) % DRAWER_TABS.length;
    }
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = DRAWER_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = DRAWER_TABS[nextIndex];
    if (!nextTab) return;
    onSelect(nextTab);
    document.getElementById(drawerTabId(nextTab))?.focus();
  }

  return (
    <button
      id={drawerTabId(tab)}
      className={selected ? 'active' : ''}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={drawerPanelId(tab)}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(tab)}
      onKeyDown={handleKeyDown}
    >
      {children}
    </button>
  );
}

function ActivityPanel({ events }: { events: string[] }) {
  return (
    <div
      id={drawerPanelId('activity')}
      className="event-stream"
      role="tabpanel"
      aria-labelledby={drawerTabId('activity')}
      tabIndex={0}
    >
      {events.map((event, index) => (
        <div key={`${event}-${index}`}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <p>{event}</p>
          <small>local</small>
        </div>
      ))}
    </div>
  );
}

function ChangesPanel({
  reports,
  onOpenGitReview,
}: {
  reports: ChangeReport[];
  onOpenGitReview: () => void;
}) {
  return (
    <div
      id={drawerPanelId('changes')}
      className="drawer-panel"
      role="tabpanel"
      aria-labelledby={drawerTabId('changes')}
      tabIndex={0}
    >
      <header className="drawer-panel-summary">
        <div>
          <strong>Run-reported file changes</strong>
          <small>Persisted on the agent node from its latest run summary.</small>
        </div>
        <div className="drawer-panel-actions">
          <span>{reports.reduce((total, report) => total + report.files.length, 0)} files</span>
          <button type="button" onClick={onOpenGitReview}>
            Review primary checkout
          </button>
        </div>
      </header>
      {reports.length ? (
        <div className="change-report-list">
          {reports.map((report) => (
            <article key={report.nodeId}>
              <header>
                <strong>{report.title}</strong>
                <span className={`drawer-status ${report.status}`}>{report.status}</span>
              </header>
              <ul>
                {report.files.map((file) => (
                  <li key={file}>
                    <FileCode2 size={12} aria-hidden="true" /> <code>{file}</code>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      ) : (
        <DrawerEmpty>No completed run has reported file changes.</DrawerEmpty>
      )}
    </div>
  );
}

function AuditPanel({
  events,
  state,
  onRefresh,
}: {
  events: AuditEvent[];
  state: 'idle' | 'loading' | 'error';
  onRefresh: () => void;
}) {
  return (
    <div
      id={drawerPanelId('audit')}
      className="drawer-panel"
      role="tabpanel"
      aria-labelledby={drawerTabId('audit')}
      tabIndex={0}
      aria-busy={state === 'loading'}
    >
      <header className="drawer-panel-summary">
        <div>
          <strong>Local audit log</strong>
          <small>Newest first. Secret-bearing metadata is not exposed to this view.</small>
        </div>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>
      {state === 'loading' && !events.length ? (
        <DrawerEmpty>Loading local audit events…</DrawerEmpty>
      ) : state === 'error' ? (
        <DrawerEmpty>Forgeboard could not read the local audit log.</DrawerEmpty>
      ) : events.length ? (
        <div className="audit-event-list">
          {events.map((event) => (
            <article key={event.sequence}>
              <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
              <strong>{event.category}</strong>
              <span>{event.action}</span>
              <small className={`audit-outcome ${event.outcome}`}>{event.outcome}</small>
            </article>
          ))}
        </div>
      ) : (
        <DrawerEmpty>No local audit events have been recorded yet.</DrawerEmpty>
      )}
    </div>
  );
}

function DrawerEmpty({ children }: { children: string }) {
  return <p className="drawer-empty">{children}</p>;
}

function drawerTabId(tab: DrawerTab): string {
  return `workspace-tab-${tab}`;
}

function drawerPanelId(tab: DrawerTab): string {
  return `workspace-panel-${tab}`;
}
