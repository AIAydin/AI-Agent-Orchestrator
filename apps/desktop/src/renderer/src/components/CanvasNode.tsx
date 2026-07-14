import {
  Bot,
  CheckCircle2,
  ChevronDown,
  FileCode2,
  FileDiff,
  Frame,
  GitPullRequest,
  Image,
  ListChecks,
  Lock,
  MonitorPlay,
  Network,
  NotebookPen,
  PanelTop,
  Play,
  Smartphone,
  TerminalSquare,
  TestTube2,
} from 'lucide-react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export interface WorkshopNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  description: string;
  status: 'idle' | 'queued' | 'running' | 'waiting' | 'failed' | 'succeeded' | 'cancelled';
  locked: boolean;
  collapsed: boolean;
  color: string;
  adapterId?: 'test-agent' | 'codex' | 'claude' | 'gemini' | 'opencode';
  permissionProfile?: 'plan-read-only' | 'worktree-write';
  prompt?: string;
  runId?: string;
  transcript?: string;
  lastRunSummary?: string;
  changedFiles?: string[];
}

export type WorkshopNode = Node<WorkshopNodeData, 'workshop'>;

export const NODE_KINDS = [
  'agent',
  'brief',
  'task',
  'file',
  'diff',
  'terminal',
  'web-preview',
  'mobile-preview',
  'test',
  'review-gate',
  'git-pr',
  'diagram',
  'whiteboard',
  'note-image',
  'group-frame',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_DEFINITIONS: Record<
  NodeKind,
  { label: string; description: string; color: string; icon: typeof Bot }
> = {
  agent: {
    label: 'Agent',
    description: 'Run a local coding-agent CLI',
    color: '#d4a85b',
    icon: Bot,
  },
  brief: {
    label: 'Product brief',
    description: 'Requirements and acceptance criteria',
    color: '#8d7de8',
    icon: NotebookPen,
  },
  task: {
    label: 'Task',
    description: 'Assignable executable work',
    color: '#58a6a6',
    icon: ListChecks,
  },
  file: {
    label: 'File',
    description: 'Live local source reference',
    color: '#6d9ed0',
    icon: FileCode2,
  },
  diff: {
    label: 'Diff / review',
    description: 'Review and select changes',
    color: '#e27b68',
    icon: FileDiff,
  },
  terminal: {
    label: 'Terminal',
    description: 'Interactive local process',
    color: '#8dbd6f',
    icon: TerminalSquare,
  },
  'web-preview': {
    label: 'Web preview',
    description: 'Isolated desktop preview',
    color: '#6099c5',
    icon: MonitorPlay,
  },
  'mobile-preview': {
    label: 'Mobile preview',
    description: 'Phone and tablet viewports',
    color: '#a27bd3',
    icon: Smartphone,
  },
  test: {
    label: 'Test',
    description: 'Run deterministic checks',
    color: '#64a774',
    icon: TestTube2,
  },
  'review-gate': {
    label: 'Review gate',
    description: 'Human and quality approval',
    color: '#d39b55',
    icon: CheckCircle2,
  },
  'git-pr': {
    label: 'Git / PR',
    description: 'Branches, commits, and approvals',
    color: '#d06870',
    icon: GitPullRequest,
  },
  diagram: {
    label: 'Diagram',
    description: 'Mermaid source and render',
    color: '#7888d8',
    icon: Network,
  },
  whiteboard: {
    label: 'Whiteboard',
    description: 'Sketch and annotate a surface',
    color: '#c482aa',
    icon: PanelTop,
  },
  'note-image': {
    label: 'Note / image',
    description: 'Lightweight local annotation',
    color: '#c5a75f',
    icon: Image,
  },
  'group-frame': {
    label: 'Group / frame',
    description: 'Contain a workflow region',
    color: '#82909b',
    icon: Frame,
  },
};

export function CanvasNode({ data, selected }: NodeProps<WorkshopNode>) {
  const definition = NODE_DEFINITIONS[data.kind];
  const Icon = definition.icon;
  return (
    <article
      className={`canvas-node ${selected ? 'selected' : ''} ${data.collapsed ? 'collapsed' : ''}`}
      style={{ '--node-accent': data.color } as React.CSSProperties}
      aria-label={`${definition.label}: ${data.title}`}
    >
      <Handle type="target" position={Position.Left} className="node-handle" />
      <header>
        <span className="node-kind-icon">
          <Icon size={15} />
        </span>
        <span className="node-kind">{definition.label}</span>
        <span className={`run-status ${data.status}`} title={data.status} />
        {data.locked && <Lock size={12} aria-label="Locked" />}
        <ChevronDown className="collapse-glyph" size={13} aria-hidden="true" />
      </header>
      <div className="node-body">
        <strong>{data.title}</strong>
        <p>{data.description || definition.description}</p>
        {data.status !== 'idle' && (
          <span className={`node-status-label ${data.status}`}>
            <Play size={10} />
            {data.status}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="node-handle" />
    </article>
  );
}

export const WORKSHOP_NODE_TYPES = { workshop: CanvasNode };
