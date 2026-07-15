import type {
  WorkflowApprovalRequest,
  WorkflowHumanDecisionRequest,
  WorkflowRevisionEscapeRequest,
} from '../../../../../shared/workflow/contracts.js';

export type WorkflowDecisionTarget =
  | { readonly kind: 'launch'; readonly request: WorkflowApprovalRequest }
  | { readonly kind: 'human'; readonly request: WorkflowHumanDecisionRequest }
  | { readonly kind: 'revision'; readonly request: WorkflowRevisionEscapeRequest };
