import type { AgentDetection, RunAdapterId } from '../../../../../shared/application/contracts.js';
import type { WorkflowStartInput } from '../../../../../shared/workflow/contracts.js';
import type { PaletteAction } from '../../shell/CommandPalette.js';
import type { NodeKind } from '../canvas/CanvasNode.js';
import type { ExtensionTemplate } from '../model/types.js';

interface WorkspacePaletteActionInput {
  readonly runnableAgents: readonly (AgentDetection & { id: RunAdapterId })[];
  readonly extensionTemplates: readonly ExtensionTemplate[];
  readonly selectedNodeTitle: string | null;
  readonly selectedWorkflowScope: WorkflowStartInput['scope'] | undefined;
  readonly canRunWorkflow: boolean;
  readonly workflowMutationsAuthorized: boolean;
  readonly workflowStartBusy: boolean;
  readonly addNode: (kind: NodeKind) => void;
  readonly addAgentNode: (adapterId: RunAdapterId) => void;
  readonly addDefaultAgentNode: () => void;
  readonly addExtensionNode: (template: ExtensionTemplate) => void;
  readonly fitCanvas: () => void;
  readonly startWorkflow: (scope: WorkflowStartInput['scope']) => void;
  readonly openGitReview: () => void;
  readonly openSettings: () => void;
  readonly closeProject: () => void;
}

export function createWorkspacePaletteActions(input: WorkspacePaletteActionInput): PaletteAction[] {
  return [
    safeAction('add-agent', 'Add an agent', 'Canvas', input.addDefaultAgentNode, [
      'create an agent',
      'new agent',
    ]),
    ...input.runnableAgents.map((agent) =>
      safeAction(
        `add-agent-${agent.id}`,
        `Add ${agent.label} agent`,
        'Canvas',
        () => input.addAgentNode(agent.id),
        [
          `create a ${agent.label} agent`,
          `new ${agent.label} agent`,
          `start a ${agent.label} agent`,
          `start ${agent.label} agent`,
        ],
      ),
    ),
    safeAction('add-brief', 'Add a product brief', 'Canvas', () => input.addNode('brief'), [
      'create a product brief',
      'new product brief',
    ]),
    ...input.extensionTemplates.map((template) =>
      safeAction(
        `add-extension-${template.key}`,
        `Add ${template.definition.displayName}`,
        `Extension · ${template.extension.manifest.name}`,
        () => input.addExtensionNode(template),
      ),
    ),
    {
      ...safeAction('fit', 'Zoom to fit the canvas', 'View', input.fitCanvas, [
        'fit canvas',
        'show everything',
      ]),
      shortcut: 'F',
    },
    ...(input.canRunWorkflow && input.workflowMutationsAuthorized
      ? [
          confirmAction('run-workflow', 'Run the saved canvas workflow', 'Workflow', () => {
            if (!input.workflowStartBusy) input.startWorkflow({ kind: 'workflow' });
          }),
        ]
      : []),
    ...(input.selectedNodeTitle === null ||
    input.selectedWorkflowScope === undefined ||
    !input.workflowMutationsAuthorized
      ? []
      : [
          confirmAction(
            'run-selected-workflow-node',
            `Run ${input.selectedNodeTitle} and everything it needs`,
            'Workflow',
            () => {
              if (!input.workflowStartBusy && input.selectedWorkflowScope !== undefined) {
                input.startWorkflow(input.selectedWorkflowScope);
              }
            },
          ),
        ]),
    safeAction('git-review', 'Review Git changes', 'Project', input.openGitReview, [
      'open git review',
      'review changes',
    ]),
    {
      ...safeAction('settings', 'Open settings', 'Application', input.openSettings, [
        'show settings',
      ]),
      shortcut: '⌘,',
    },
    confirmAction('close', 'Close project', 'Project', input.closeProject),
  ];
}

function safeAction(
  id: string,
  label: string,
  section: string,
  run: () => void,
  voiceAliases?: readonly string[],
): PaletteAction {
  return {
    id,
    label,
    section,
    run,
    voiceSafety: 'safe',
    ...(voiceAliases ? { voiceAliases } : {}),
  };
}

function confirmAction(id: string, label: string, section: string, run: () => void): PaletteAction {
  return { id, label, section, run, voiceSafety: 'confirm' };
}
