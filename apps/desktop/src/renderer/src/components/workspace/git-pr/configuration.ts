import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import type { GitPrNodeConfiguration } from './types.js';

export function gitPrConfiguration(
  data: WorkshopNodeData,
  defaultRemote: string,
): GitPrNodeConfiguration {
  return {
    ...(data.deliveryTarget === undefined ? {} : { targetRunId: data.deliveryTarget.runId }),
    remote: data.remote ?? defaultRemote,
    destinationBranch: data.destinationBranch ?? '',
    baseBranch: data.baseBranch ?? 'main',
    pullRequestTitle: data.pullRequestTitle ?? data.title,
    pullRequestBody: data.pullRequestBody ?? '',
    pullRequestDraft: data.pullRequestDraft ?? false,
    ...(data.pullRequestUrl === undefined ? {} : { pullRequestUrl: data.pullRequestUrl }),
  };
}

export function gitPrNodeDataPatch(
  patch: Partial<GitPrNodeConfiguration>,
): Partial<WorkshopNodeData> {
  const data: Partial<WorkshopNodeData> = {};
  if ('targetRunId' in patch) {
    data.deliveryTarget =
      patch.targetRunId === undefined ? undefined : { kind: 'agent-run', runId: patch.targetRunId };
  }
  if (patch.remote !== undefined) data.remote = patch.remote;
  if (patch.destinationBranch !== undefined) data.destinationBranch = patch.destinationBranch;
  if (patch.baseBranch !== undefined) data.baseBranch = patch.baseBranch;
  if (patch.pullRequestTitle !== undefined) data.pullRequestTitle = patch.pullRequestTitle;
  if (patch.pullRequestBody !== undefined) data.pullRequestBody = patch.pullRequestBody;
  if (patch.pullRequestDraft !== undefined) data.pullRequestDraft = patch.pullRequestDraft;
  if ('pullRequestUrl' in patch) data.pullRequestUrl = patch.pullRequestUrl;
  return data;
}
