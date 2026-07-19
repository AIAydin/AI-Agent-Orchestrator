export interface AgentLaunchAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface AgentLaunchAuditDetail {
  readonly runId: string;
  readonly planId: string;
  readonly nodeId: string;
  readonly adapterId: string;
  readonly branch: string | null;
  readonly disclosureFingerprint: string;
}

/** Returns a single-use, fail-closed authorization audit checkpoint for one exact process spawn. */
export function createAgentLaunchAuditCheckpoint(
  sink: AgentLaunchAuditSink,
  detail: AgentLaunchAuditDetail,
): () => void {
  let recorded = false;
  return () => {
    if (recorded) {
      throw new Error('The prepared agent launch attempted to authorize more than one process.');
    }
    sink.appendAudit('agent-run', 'launch', 'allowed', {
      ...detail,
      phase: 'authorized-before-spawn',
    });
    recorded = true;
  };
}
