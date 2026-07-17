import { useCallback } from 'react';

import { GitPrNodeInspector } from './GitPrNodeInspector.js';
import type { GitPrNodeConfiguration } from './types.js';
import { useGitPrNodeController } from './useGitPrNodeController.js';

interface NodeLabelSource {
  readonly id: string;
  readonly data: { readonly title: string };
}

interface AgentLabelSource {
  readonly id: string;
  readonly label: string;
}

export interface OperationalGitPrNodeInspectorProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly nodeId: string;
  readonly locked: boolean;
  readonly configurationReadOnly: boolean;
  readonly configuration: GitPrNodeConfiguration;
  readonly nodes: readonly NodeLabelSource[];
  readonly agents: readonly AgentLabelSource[];
  readonly onRecord: () => void;
  readonly onConfigurationChange: (patch: Partial<GitPrNodeConfiguration>) => void;
  readonly onOpenReadiness: (runId: string) => void;
  readonly onError: (message: string) => void;
}

export function OperationalGitPrNodeInspector(props: OperationalGitPrNodeInspectorProps) {
  const onPullRequestCreated = useCallback(
    (pullRequestUrl: string) => {
      props.onRecord();
      props.onConfigurationChange({ pullRequestUrl });
    },
    [props.onConfigurationChange, props.onRecord],
  );
  const controller = useGitPrNodeController({
    projectId: props.projectId,
    configuration: props.configuration,
    nodes: props.nodes,
    agents: props.agents,
    onError: props.onError,
    onPullRequestCreated,
  });
  return (
    <GitPrNodeInspector
      projectName={props.projectName}
      nodeId={props.nodeId}
      locked={props.locked}
      configurationReadOnly={props.configurationReadOnly}
      configuration={props.configuration}
      controller={controller}
      onRecord={props.onRecord}
      onConfigurationChange={props.onConfigurationChange}
      onOpenReadiness={props.onOpenReadiness}
    />
  );
}
