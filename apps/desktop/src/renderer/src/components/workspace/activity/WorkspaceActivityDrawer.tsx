import { useEffect, useRef, useState } from 'react';
import { Activity, FileCode2, GitBranch, PanelBottomClose, ShieldCheck } from 'lucide-react';

import type { AuditEvent } from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import type { ChangeReport } from '../model/types.js';
import { WorkspaceTooltip } from '../shell/tooltips/WorkspaceTooltip.js';

type DrawerTab = 'activity' | 'changes' | 'audit';
const DRAWER_TABS: readonly DrawerTab[] = ['activity', 'changes', 'audit'];

interface WorkspaceActivityDrawerProps {
  events: string[];
  changeReports: ChangeReport[];
  onOpenGitReview: (runId?: string) => void;
  onClose: () => void;
}

export function WorkspaceActivityDrawer({
  events,
  changeReports,
  onOpenGitReview,
  onClose,
}: WorkspaceActivityDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>('activity');
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditState, setAuditState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [auditRefresh, setAuditRefresh] = useState(0);
  const [eventAnnouncement, setEventAnnouncement] = useState({ message: '', sequence: 0 });
  const eventsSeenRef = useRef(false);

  useEffect(() => {
    const latest = events[0];
    if (!eventsSeenRef.current) {
      eventsSeenRef.current = true;
      return;
    }
    if (latest === undefined) return;
    setEventAnnouncement(({ sequence }) => ({ message: latest, sequence: sequence + 1 }));
  }, [events]);

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
          <DrawerTabButton tab="audit" activeTab={tab} onSelect={setTab}>
            <ShieldCheck size={14} aria-hidden="true" /> History
          </DrawerTabButton>
        </div>
        <WorkspaceTooltip content="Close the activity panel">
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close activity panel"
          >
            <PanelBottomClose size={16} aria-hidden="true" />
          </button>
        </WorkspaceTooltip>
      </header>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        <span key={eventAnnouncement.sequence}>{eventAnnouncement.message}</span>
      </span>
      {tab === 'activity' && <ActivityPanel events={events} />}
      {tab === 'changes' && (
        <ChangesPanel reports={changeReports} onOpenGitReview={onOpenGitReview} />
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
      {events.length === 0 ? (
        <DrawerEmpty role="status">Run activity will appear here.</DrawerEmpty>
      ) : null}
    </div>
  );
}

function ChangesPanel({
  reports,
  onOpenGitReview,
}: {
  reports: ChangeReport[];
  onOpenGitReview: (runId?: string) => void;
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
          <strong>Files changed by runs</strong>
          <small>Files each agent changed in its latest run.</small>
        </div>
        <div className="drawer-panel-actions">
          <span>{reports.reduce((total, report) => total + report.files.length, 0)} files</span>
          <button type="button" onClick={() => onOpenGitReview()}>
            Review project changes
          </button>
        </div>
      </header>
      {reports.length ? (
        <div className="change-report-list">
          {reports.map((report) => {
            const reviewRunId =
              report.nodeKind === 'agent' &&
              report.runId !== null &&
              report.runPermissionProfile !== null &&
              report.runPermissionProfile !== 'plan-read-only' &&
              ['succeeded', 'failed', 'cancelled'].includes(report.status)
                ? report.runId
                : null;
            return (
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
                {reviewRunId !== null && (
                  <div className="drawer-panel-actions">
                    <button type="button" onClick={() => onOpenGitReview(reviewRunId)}>
                      Review this agent’s changes
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <DrawerEmpty role="status">Run an agent to see its changed files here.</DrawerEmpty>
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
          <strong>App history</strong>
          <small>Newest first. Secrets are never shown here.</small>
        </div>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>
      {state === 'loading' && !events.length ? (
        <DrawerEmpty role="status">Loading history…</DrawerEmpty>
      ) : state === 'error' ? (
        <DrawerEmpty role="alert">Couldn't load history. Refresh to try again.</DrawerEmpty>
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
        <DrawerEmpty role="status">Nothing has been recorded yet.</DrawerEmpty>
      )}
    </div>
  );
}

function DrawerEmpty({ children, role }: { children: string; role: 'alert' | 'status' }) {
  return (
    <p className="drawer-empty" role={role}>
      {children}
    </p>
  );
}

function drawerTabId(tab: DrawerTab): string {
  return `workspace-tab-${tab}`;
}

function drawerPanelId(tab: DrawerTab): string {
  return `workspace-panel-${tab}`;
}
