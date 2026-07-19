import type {
  PreviewSessionSnapshot,
  PreviewStartInput,
} from '../../../../../shared/application/contracts.js';
import type { PreviewTargetView } from '../../../../../shared/preview/targets.js';
import type { PreviewRendererOperations } from '../controller/operations.js';
import type { PreviewPresetId } from '../devices/presets.js';

export type ComparisonSide = 'left' | 'right';
export type ComparisonSlot = `comparison-${ComparisonSide}`;
export type AgentPreviewTarget = Extract<PreviewTargetView['target'], { kind: 'agent-run' }>;

export interface PreviewComparisonConfiguration {
  leftTarget?: AgentPreviewTarget;
  rightTarget?: AgentPreviewTarget;
  leftPreset: PreviewPresetId;
  rightPreset: PreviewPresetId;
}

export interface PreviewComparisonPanelProps {
  projectId: string;
  nodeId: string;
  baseInput: Omit<PreviewStartInput, 'target' | 'slot'>;
  targets: readonly PreviewTargetView[];
  configuration: PreviewComparisonConfiguration;
  launchConfigured: boolean;
  readOnly: boolean;
  operations: PreviewRendererOperations | null;
  onConfiguration: (configuration: PreviewComparisonConfiguration) => void;
  onError: (message: string) => void;
}

export interface ComparisonRuntimeState {
  left: PreviewSessionSnapshot | null;
  right: PreviewSessionSnapshot | null;
}
