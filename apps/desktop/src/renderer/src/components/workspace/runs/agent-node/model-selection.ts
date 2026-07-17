import type { AgentDetection } from '../../../../../../shared/application/contracts.js';

export function effectiveNodeModel(
  agent: Pick<AgentDetection, 'capabilities'> | undefined,
  nodeModel: string | undefined,
  settingsDefault: string | undefined,
): string | undefined {
  if (agent?.capabilities?.modelSelection !== true) return undefined;
  return nodeModel?.trim() || settingsDefault?.trim() || undefined;
}
