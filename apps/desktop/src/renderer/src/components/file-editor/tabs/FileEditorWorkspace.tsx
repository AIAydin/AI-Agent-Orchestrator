import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { FilePlus2, X } from 'lucide-react';

import { FileEditorPanel, type FileEditorSessionState } from '../FileEditorPanel.js';
import type { MonacoLoader } from '../monaco-loader.js';
import type { FileEditorOperations } from '../operations.js';
import { WorkspaceTooltip } from '../../workspace/shell/tooltips/WorkspaceTooltip.js';
import './FileEditorWorkspace.css';

const MAX_OPEN_FILE_TABS = 20;

export interface FileEditorTabTarget {
  readonly projectId: string;
  readonly relativePath: string;
}

export interface FileEditorTabRequest extends FileEditorTabTarget {
  readonly requestId: number;
  readonly position?: { readonly line: number; readonly column: number };
}

interface OpenFileTab extends FileEditorTabTarget {
  readonly navigation: {
    readonly requestId: number;
    readonly line: number;
    readonly column: number;
  } | null;
}

interface FileEditorWorkspaceState {
  readonly tabs: readonly OpenFileTab[];
  readonly activeKey: string;
  readonly message: string | null;
}

export function FileEditorWorkspace({
  primary,
  requestedTab,
  operations,
  readOnly = false,
  onBrowseFiles,
  onRevealInTree,
  onFileDragStart,
  monacoLoader,
  theme,
}: {
  readonly primary: FileEditorTabTarget;
  readonly requestedTab?: FileEditorTabRequest | undefined;
  readonly operations: FileEditorOperations;
  readonly readOnly?: boolean;
  readonly onBrowseFiles: () => void;
  readonly onRevealInTree: (relativePath: string) => void;
  readonly onFileDragStart?: (dataTransfer: DataTransfer, target: FileEditorTabTarget) => void;
  readonly monacoLoader?: MonacoLoader | undefined;
  readonly theme?: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' | undefined;
}) {
  const primaryKey = tabKey(primary);
  const [{ tabs, activeKey, message }, setWorkspace] = useState<FileEditorWorkspaceState>({
    tabs: [{ ...primary, navigation: null }],
    activeKey: primaryKey,
    message: null,
  });
  const [states, setStates] = useState<Readonly<Record<string, FileEditorSessionState>>>({});

  useEffect(() => {
    openTab({ ...primary, navigation: null }, setWorkspace);
  }, [primary.projectId, primary.relativePath]);

  useEffect(() => {
    if (requestedTab === undefined) return;
    openTab(
      {
        projectId: requestedTab.projectId,
        relativePath: requestedTab.relativePath,
        navigation:
          requestedTab.position === undefined
            ? null
            : {
                requestId: requestedTab.requestId,
                line: requestedTab.position.line,
                column: requestedTab.position.column,
              },
      },
      setWorkspace,
    );
  }, [requestedTab?.requestId]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tabKey(tab) === activeKey) ?? null,
    [activeKey, tabs],
  );

  const closeTab = (key: string): void => {
    const state = states[key];
    if (state?.dirty === true || state?.status === 'loading') return;
    setWorkspace((current) => {
      const index = current.tabs.findIndex((tab) => tabKey(tab) === key);
      const nextTabs = current.tabs.filter((tab) => tabKey(tab) !== key);
      const fallback = nextTabs[Math.min(Math.max(index, 0), Math.max(nextTabs.length - 1, 0))];
      return {
        tabs: nextTabs,
        activeKey:
          current.activeKey === key
            ? fallback === undefined
              ? ''
              : tabKey(fallback)
            : current.activeKey,
        message: null,
      };
    });
    setStates((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  return (
    <section className="file-editor-workspace" aria-label="Open file tabs">
      <header className="file-editor-tabs">
        <div role="tablist" aria-label="Open project files">
          {tabs.map((tab) => {
            const key = tabKey(tab);
            const active = key === activeKey;
            const state = states[key];
            const dirty = state?.dirty === true;
            const contextDraggable =
              onFileDragStart !== undefined && state?.status === 'ready' && !dirty;
            return (
              <div className={`file-editor-tab${active ? ' active' : ''}`} key={key}>
                <WorkspaceTooltip
                  content={
                    dirty
                      ? 'Save or discard your changes before dragging this file'
                      : contextDraggable
                        ? `Drag ${tab.relativePath} to an agent to share it`
                        : tab.relativePath
                  }
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    draggable={contextDraggable}
                    onDragStart={(event) => {
                      if (!contextDraggable) {
                        event.preventDefault();
                        return;
                      }
                      onFileDragStart(event.dataTransfer, {
                        projectId: tab.projectId,
                        relativePath: tab.relativePath,
                      });
                    }}
                    onClick={() =>
                      setWorkspace((current) => ({
                        ...current,
                        activeKey: key,
                        message: null,
                      }))
                    }
                  >
                    <span>{fileName(tab.relativePath)}</span>
                    {dirty ? <em aria-label="Unsaved changes">●</em> : null}
                  </button>
                </WorkspaceTooltip>
                <WorkspaceTooltip
                  content={
                    dirty ? 'Save or discard your changes before closing this tab' : 'Close tab'
                  }
                >
                  <button
                    type="button"
                    className="file-editor-tab-close"
                    aria-label={`Close ${tab.relativePath}`}
                    disabled={dirty || state === undefined || state.status === 'loading'}
                    onClick={() => closeTab(key)}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </WorkspaceTooltip>
              </div>
            );
          })}
        </div>
        <button type="button" className="file-editor-tab-add" onClick={onBrowseFiles}>
          <FilePlus2 size={13} aria-hidden="true" />
          Browse
        </button>
      </header>

      {message !== null ? (
        <p className="file-editor-tabs-message" role="alert">
          {message}
        </p>
      ) : null}

      <div className="file-editor-tab-panels">
        {tabs.map((tab) => {
          const key = tabKey(tab);
          const active = key === activeKey;
          return (
            <div
              key={key}
              role="tabpanel"
              aria-label={tab.relativePath}
              hidden={!active}
              className="file-editor-tab-panel"
            >
              <FileEditorPanel
                projectId={tab.projectId}
                relativePath={tab.relativePath}
                operations={operations}
                readOnly={readOnly}
                onRevealInTree={() => onRevealInTree(tab.relativePath)}
                onSessionStateChange={(state) =>
                  setStates((current) =>
                    sameSessionState(current[key], state) ? current : { ...current, [key]: state },
                  )
                }
                {...(tab.navigation === null ? {} : { initialPosition: tab.navigation })}
                {...(monacoLoader === undefined ? {} : { monacoLoader })}
                {...(theme === undefined ? {} : { theme })}
              />
            </div>
          );
        })}
        {activeTab === null ? (
          <div className="file-editor-tabs-empty" role="status">
            <p>Files you open will show up here as tabs.</p>
            <button type="button" onClick={onBrowseFiles}>
              Browse project files
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function openTab(
  target: OpenFileTab,
  setWorkspace: Dispatch<SetStateAction<FileEditorWorkspaceState>>,
): void {
  const key = tabKey(target);
  setWorkspace((current) => {
    const existing = current.tabs.findIndex((tab) => tabKey(tab) === key);
    if (existing >= 0) {
      return {
        tabs: current.tabs.map((tab, index) => (index === existing ? target : tab)),
        activeKey: key,
        message: null,
      };
    }
    if (current.tabs.length >= MAX_OPEN_FILE_TABS) {
      return {
        ...current,
        message: `You can keep up to ${String(MAX_OPEN_FILE_TABS)} files open at once. Close a tab to open another.`,
      };
    }
    return { tabs: [...current.tabs, target], activeKey: key, message: null };
  });
}

function tabKey(target: FileEditorTabTarget): string {
  return `${target.projectId}:${target.relativePath}`;
}

function fileName(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}

function sameSessionState(
  left: FileEditorSessionState | undefined,
  right: FileEditorSessionState,
): boolean {
  return left?.dirty === right.dirty && left.status === right.status;
}
