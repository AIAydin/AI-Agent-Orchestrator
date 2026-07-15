import type { RepositoryService } from '@forgeboard/git-engine';

import type { AppSettings } from '../../shared/contracts.js';
import { GitTargetResolver } from '../git-target-resolver.js';
import type { RunService } from '../run-service.js';
import type { LocalStore } from '../storage.js';
import { ExactCheckExecutor } from './exact-check-executor.js';
import { ExactCheckWorkflowAdapter } from './exact-check-workflow-adapter.js';
import { WorkflowAgentExecutor } from './workflow-agent-executor.js';
import { FileNodeWorkflowContextResolver } from './workflow-context-resolver.js';
import { MainWorkflowEvidenceBridge } from './workflow-evidence-bridge.js';
import type {
  WorkflowEvidenceBridge,
  WorkflowHostInteractionNotification,
  WorkflowHostNotification,
} from './workflow-host-contracts.js';
import { WorkflowHost } from './workflow-host.js';

export interface WorkflowRuntimeComposition {
  readonly createHost: (
    emit: (notification: WorkflowHostNotification) => void,
    emitInteraction?: (notification: WorkflowHostInteractionNotification) => void,
  ) => WorkflowHost;
  readonly resetForPrivacy: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export function createWorkflowRuntimeComposition(input: {
  readonly store: LocalStore;
  readonly runs: Pick<RunService, 'executionOperations'> &
    Partial<Pick<RunService, 'subscribeExecutionEvents'>>;
  readonly repositories: RepositoryService;
  readonly getSettings: () => AppSettings;
  readonly evidence?: WorkflowEvidenceBridge;
}): WorkflowRuntimeComposition {
  const gitTargets = new GitTargetResolver(input.store, input.repositories, input.getSettings);
  const exactChecks = new ExactCheckExecutor(input.store, gitTargets, input.getSettings);
  const context = new FileNodeWorkflowContextResolver(input.store);
  const evidence =
    input.evidence ?? new MainWorkflowEvidenceBridge({ resolveContext: context.resolveEvidence });
  const executors = [
    new WorkflowAgentExecutor(input.runs.executionOperations(), context.resolve, {
      ...(input.runs.subscribeExecutionEvents === undefined
        ? {}
        : {
            subscribeEvents: (ownerId, listener) =>
              input.runs.subscribeExecutionEvents!(ownerId, listener),
          }),
    }),
    new ExactCheckWorkflowAdapter(exactChecks),
  ];
  let disposed = false;
  return {
    createHost: (emit, emitInteraction) =>
      new WorkflowHost(input.store, executors, {
        evidence,
        emit,
        ...(emitInteraction === undefined ? {} : { emitInteraction }),
      }),
    resetForPrivacy: async () => await exactChecks.resetForPrivacy(),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await exactChecks.dispose();
    },
  };
}
