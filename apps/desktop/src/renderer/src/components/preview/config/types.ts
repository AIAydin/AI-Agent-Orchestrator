import type {
  PreviewCommand,
  PreviewTarget,
  PreviewTargetView,
} from '../../../../../shared/preview/targets.js';

export type PreviewTargetOption = PreviewTargetView;

export interface PreviewConfigurationValue {
  target: PreviewTarget;
  command?: PreviewCommand;
  packageScript: string;
  cwdRelative: string;
  readinessPath: string;
  urlPath: string;
}
