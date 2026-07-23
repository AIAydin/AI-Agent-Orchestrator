import { ChevronRight, Files, GitBranch, Layers3, Search } from 'lucide-react';

import type {
  AgentDetection,
  Project,
  RunAdapterId,
} from '../../../../../shared/application/contracts.js';
import type { ProjectFileBrowserOperations } from '../../file-editor/browser/useProjectFileBrowser.js';
import type { NodeKind, WorkshopNode } from '../canvas/CanvasNode.js';
import { WorkspaceProjectTree } from '../context-dnd/WorkspaceProjectTree.js';
import type { WorkspaceContextDragPayload } from '../context-dnd/contracts.js';
import type { ExtensionTemplate } from '../model/types.js';
import { providerTheme } from '../node-registry/provider-themes.js';
import { BUILT_IN_NODE_REGISTRY, type NodeTypeRegistry } from '../node-registry/registry.js';

interface WorkspaceRailProps {
  project: Project;
  tab: 'project' | 'nodes';
  search: string;
  templates: NodeKind[];
  extensionTemplates: ExtensionTemplate[];
  nodes: WorkshopNode[];
  nodeRegistry?: NodeTypeRegistry;
  fileOperations: ProjectFileBrowserOperations;
  initializingGit: boolean;
  collaborationGraphReadOnly: boolean;
  runnableAgents: readonly (AgentDetection & { id: RunAdapterId })[];
  onTabChange: (tab: 'project' | 'nodes') => void;
  onSearchChange: (value: string) => void;
  onAddNode: (kind: NodeKind) => void;
  onAddAgentNode: (adapterId: RunAdapterId) => void;
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
  nodeRegistry = BUILT_IN_NODE_REGISTRY,
  fileOperations,
  initializingGit,
  collaborationGraphReadOnly,
  runnableAgents,
  onTabChange,
  onSearchChange,
  onAddNode,
  onAddAgentNode,
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
            nodeRegistry={nodeRegistry}
            initializingGit={initializingGit}
            runnableAgents={runnableAgents}
            onAddNode={onAddNode}
            onAddAgentNode={onAddAgentNode}
            onAddExtensionNode={onAddExtensionNode}
            onInitializeGit={onInitializeGit}
          />
        </>
      ) : (
        <CanvasNodeList nodes={nodes} nodeRegistry={nodeRegistry} onSelectNode={onSelectNode} />
      )}
    </aside>
  );
}

interface ProjectTemplatesProps {
  project: Project;
  templates: NodeKind[];
  extensionTemplates: ExtensionTemplate[];
  nodeRegistry: NodeTypeRegistry;
  initializingGit: boolean;
  runnableAgents: readonly (AgentDetection & { id: RunAdapterId })[];
  onAddNode: (kind: NodeKind) => void;
  onAddAgentNode: (adapterId: RunAdapterId) => void;
  onAddExtensionNode: (template: ExtensionTemplate) => void;
  onInitializeGit: () => void;
}

function ProjectTemplates({
  project,
  templates,
  extensionTemplates,
  nodeRegistry,
  initializingGit,
  runnableAgents,
  onAddNode,
  onAddAgentNode,
  onAddExtensionNode,
  onInitializeGit,
}: ProjectTemplatesProps) {
  return (
    <>
      <section className="repository-summary">
        <header>
          <GitBranch size={14} />
          <strong>{project.health.branch ?? 'Git not set up yet'}</strong>
          <span
            className={project.health.dirty ? 'dirty-dot' : 'clean-dot'}
            role="img"
            aria-label={
              project.health.dirty
                ? 'Project has changes not yet recorded in Git'
                : 'All project changes are recorded in Git'
            }
          />
        </header>
        <small>{project.path}</small>
        {!project.health.isGitRepository && (
          <div className="repository-initialize">
            <p>
              Set up Git so agents can work in their own copies and you can review their changes.
            </p>
            <button type="button" disabled={initializingGit} onClick={onInitializeGit}>
              <GitBranch size={14} aria-hidden="true" />
              {initializingGit ? 'Setting up…' : 'Set up Git…'}
            </button>
            <small>Your files stay exactly as they are.</small>
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
          <h2>Agents</h2>
          <span>{runnableAgents.length}</span>
        </header>
        <div className="template-list">
          {runnableAgents.map((agent) => {
            const theme = providerTheme(agent.id);
            return (
              <button type="button" key={agent.id} onClick={() => onAddAgentNode(agent.id)}>
                <span
                  className="agent-monogram-badge"
                  style={{ background: theme?.accent ?? '#d4a85b' }}
                >
                  {theme?.monogram ?? 'A'}
                </span>
                <span>
                  <strong>{theme?.label ?? agent.label}</strong>
                  <small>Live CLI session window</small>
                </span>
                <ChevronRight size={13} />
              </button>
            );
          })}
        </div>
      </section>
      <section className="template-section">
        <header>
          <h2>Node templates</h2>
          <span>{templates.length + extensionTemplates.length}</span>
        </header>
        <div className="template-list">
          {templates.map((kind) => {
            const definition = nodeRegistry.resolve({ kind });
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
          {extensionTemplates.map((template) => {
            const definition = nodeRegistry.resolve({
              kind: 'extension',
              extensionId: template.extension.manifest.id,
              extensionVersion: template.extension.manifest.version,
              extensionNodeTypeId: template.definition.id,
              extensionDefinition: template.definition,
            });
            const Icon = definition.icon;
            return (
              <button
                type="button"
                key={template.key}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    'application/x-forgeboard-extension-node',
                    template.key,
                  );
                  event.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onAddExtensionNode(template)}
              >
                <span style={{ color: definition.color }}>
                  <Icon size={15} />
                </span>
                <span>
                  <strong>{definition.label}</strong>
                  <small>
                    {template.extension.manifest.name} · {template.definition.category}
                  </small>
                </span>
                <ChevronRight size={13} />
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

function CanvasNodeList({
  nodes,
  nodeRegistry,
  onSelectNode,
}: {
  nodes: WorkshopNode[];
  nodeRegistry: NodeTypeRegistry;
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
          const definition = nodeRegistry.resolve(node.data);
          const Icon = definition.icon;
          return (
            <button type="button" key={node.id} onClick={() => onSelectNode(node)}>
              <span style={{ color: node.data.color }}>
                <Icon size={14} />
              </span>
              <span>
                <strong title={node.data.title}>{node.data.title}</strong>
                <small>{definition.label}</small>
              </span>
              <span
                className={`run-status ${node.data.status}`}
                role="img"
                aria-label={`Status: ${node.data.status}`}
              />
            </button>
          );
        })}
        {!nodes.length && <p role="status">No matching nodes on this canvas.</p>}
      </div>
    </section>
  );
}
