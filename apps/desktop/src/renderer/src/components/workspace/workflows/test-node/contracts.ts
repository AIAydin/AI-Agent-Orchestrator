import type {
  WorkflowArtifactReference,
  WorkflowArtifactActionInput,
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
} from '../../../../../../shared/workflow/contracts.js';
import type { AppSettings } from '../../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';

export type TestNodeArtifact = WorkflowArtifactReference;

export interface TestNodePanelProps {
  readonly projectId: string;
  readonly node: WorkshopNode;
  readonly settings: AppSettings;
  readonly locked: boolean;
  readonly configurationReadOnly: boolean;
  readonly mutationsAuthorized: boolean;
  readonly executions: readonly WorkflowExecutionView[];
  readonly interactionEvents: readonly WorkflowInteractionEventEnvelope[];
  readonly busyAction: string | null;
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
  readonly onStart: (nodeId: string) => void;
  readonly onCancel: (input: { executionId: string; nodeId: string; attempt: number }) => void;
  readonly onRevealArtifact: (input: WorkflowArtifactActionInput) => Promise<void>;
  readonly onOpenArtifact: (input: WorkflowArtifactActionInput) => Promise<void>;
  readonly onError: (message: string) => void;
}
