import { ChevronRight, Files, GitBranch, Layers3, Puzzle, Search } from 'lucide-react';

import type { Project } from '../../../../../shared/application/contracts.js';
import type { ProjectFileBrowserOperations } from '../../file-editor/browser/useProjectFileBrowser.js';
import { NODE_DEFINITIONS, type NodeKind, type WorkshopNode } from '../canvas/CanvasNode.js';
import { WorkspaceProjectTree } from '../context-dnd/WorkspaceProjectTree.js';
import type { WorkspaceContextDragPayload } from '../context-dnd/contracts.js';
import type { ExtensionTemplate } from '../model/types.js';

interface WorkspaceRailProps {
  project: Project;
  tab: 'project' | 'nodes';
  search: string;
  templates: NodeKind[];
  extensionTemplates: ExtensionTemplate[];
  nodes: WorkshopNode[];
  fileOperations: ProjectFileBrowserOperations;
  initializingGit: boolean;
  collaborationGraphReadOnly: boolean;
  onTabChange: (tab: 'project' | 'nodes') => void;
  onSearchChange: (value: string) => void;
  onAddNode: (kind: NodeKind) => void;
  onAddExtensionNode: (template: ExtensionTemplate) => void;
  onInitializeGit: () => void;
  onSelectNode: (node: WorkshopNode) => void;
  onAttachAgentContext: (
    targetNodeId: string,
    payload: WorkspaceContextDragPayload,
  ) => Promise<void>;
}

export function WorkspaceRail({
  project,
  tab,
  search,
  templates,
  extensionTemplates,
  nodes,
  fileOperations,
  initializingGit,
  collaborationGraphReadOnly,
  onTabChange,
  onSearchChange,
  onAddNode,
  onAddExtensionNode,
  onInitializeGit,
  onSelectNode,
  onAttachAgentContext,
}: WorkspaceRailProps) {
  return (
    <aside className="project-rail">
      <div className="rail-tabs">
        <button
          className={tab === 'project' ? 'active' : ''}
          type="button"
          aria-pressed={tab === 'project'}
          onClick={() => onTabChange('project')}
        >
          <Files size={15} /> Project
        </button>
        <button
          className={tab === 'nodes' ? 'active' : ''}
          type="button"
          aria-pressed={tab === 'nodes'}
          onClick={() => onTabChange('nodes')}
        >
          <Layers3 size={15} /> Nodes
        </button>
      </div>
      <div className="rail-search">
        <Search size={14} />
        <input
          name="workspace-rail-search"
          aria-label={tab === 'project' ? 'Search node templates' : 'Search canvas nodes'}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={tab === 'project' ? 'Find node templates' : 'Find canvas nodes'}
        />
      </div>
      {tab === 'project' ? (
        <>
          <WorkspaceProjectTree
            projectId={project.id}
            operations={fileOperations}
            agentTargets={nodes}
            readOnly={collaborationGraphReadOnly}
            onAttach={onAttachAgentContext}
          />
          <ProjectTemplates
            project={project}
            templates={templates}
            extensionTemplates={extensionTemplates}
            initializingGit={initializingGit}
            onAddNode={onAddNode}
            onAddExtensionNode={onAddExtensionNode}
            onInitializeGit={onInitializeGit}
          />
        </>
      ) : (
        <CanvasNodeList nodes={nodes} onSelectNode={onSelectNode} />
      )}
      <footer>
        <ShieldStatus project={project} />
      </footer>
    </aside>
  );
}

interface ProjectTemplatesProps {
  project: Project;
  templates: NodeKind[];
  extensionTemplates: ExtensionTemplate[];
  initializingGit: boolean;
  onAddNode: (kind: NodeKind) => void;
  onAddExtensionNode: (template: ExtensionTemplate) => void;
  onInitializeGit: () => void;
}

function ProjectTemplates({
  project,
  templates,
  extensionTemplates,
  initializingGit,
  onAddNode,
  onAddExtensionNode,
  onInitializeGit,
}: ProjectTemplatesProps) {
  return (
    <>
      <section className="repository-summary">
        <header>
          <GitBranch size={14} />
          <strong>{project.health.branch ?? 'Not a Git repository'}</strong>
          <span
            className={project.health.dirty ? 'dirty-dot' : 'clean-dot'}
            role="img"
            aria-label={
              project.health.dirty
                ? 'Repository has uncommitted changes'
                : 'Repository working tree is clean'
            }
          />
        </header>
        <small>{project.path}</small>
        {!project.health.isGitRepository && (
          <div className="repository-initialize">
            <p>Agent worktrees and reviewed commits require Git metadata.</p>
            <button type="button" disabled={initializingGit} onClick={onInitializeGit}>
              <GitBranch size={14} aria-hidden="true" />
              {initializingGit ? 'Initializing…' : 'Initialize Git…'}
            </button>
            <small>Existing files stay untouched and uncommitted.</small>
          </div>
        )}
        {project.health.frameworks.length > 0 && (
          <div>
            {project.health.frameworks.map((framework) => (
              <span key={framework}>{framework}</span>
            ))}
          </div>
        )}
      </section>
      <section className="template-section">
        <header>
          <h2>Node templates</h2>
          <span>{templates.length + extensionTemplates.length}</span>
        </header>
        <div className="template-list">
          {templates.map((kind) => {
            const definition = NODE_DEFINITIONS[kind];
            const Icon = definition.icon;
            return (
              <button
                type="button"
                key={kind}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-forgeboard-node', kind);
                  event.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onAddNode(kind)}
              >
                <span style={{ color: definition.color }}>
                  <Icon size={15} />
                </span>
                <span>
                  <strong>{definition.label}</strong>
                  <small>{definition.description}</small>
                </span>
                <ChevronRight size={13} />
              </button>
            );
          })}
          {extensionTemplates.map((template) => (
            <button
              type="button"
              key={template.key}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-forgeboard-extension-node', template.key);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onAddExtensionNode(template)}
            >
              <span style={{ color: template.definition.color }}>
                <Puzzle size={15} />
              </span>
              <span>
                <strong>{template.definition.displayName}</strong>
                <small>
                  {template.extension.manifest.name} · {template.definition.category}
                </small>
              </span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function CanvasNodeList({
  nodes,
  onSelectNode,
}: {
  nodes: WorkshopNode[];
  onSelectNode: (node: WorkshopNode) => void;
}) {
  return (
    <section className="rail-node-section">
      <header>
        <h2>Canvas nodes</h2>
        <span>{nodes.length}</span>
      </header>
      <div className="rail-node-list">
        {nodes.map((node) => {
          const definition = NODE_DEFINITIONS[node.data.kind];
          const Icon = definition.icon;
          return (
            <button type="button" key={node.id} onClick={() => onSelectNode(node)}>
              <span style={{ color: node.data.color }}>
                <Icon size={14} />
              </span>
              <span>
                <strong>{node.data.title}</strong>
                <small>{definition.label}</small>
              </span>
              <span className={`run-status ${node.data.status}`} title={node.data.status} />
            </button>
          );
        })}
        {!nodes.length && <p>No matching nodes on this canvas.</p>}
      </div>
    </section>
  );
}

function ShieldStatus({ project }: { project: Project }) {
  return (
    <div className="rail-safety">
      <span className={project.health.sensitiveWarnings.length ? 'warning' : 'safe'}>
        {project.health.sensitiveWarnings.length ? '!' : '✓'}
      </span>
      <div>
        <strong>
          {project.health.sensitiveWarnings.length
            ? 'Sensitive files protected'
            : 'Context guard active'}
        </strong>
        <small>
          {project.health.sensitiveWarnings.length
            ? `${project.health.sensitiveWarnings.length} warning${project.health.sensitiveWarnings.length === 1 ? '' : 's'} found`
            : 'Ignored and credential files excluded'}
        </small>
      </div>
    </div>
  );
}
