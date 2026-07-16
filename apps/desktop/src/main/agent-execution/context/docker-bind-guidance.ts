import type { AgentEvent } from '@forgeboard/agent-adapters';

const MAX_MATCH_BUFFER = 32 * 1024;

export const DOCKER_CONTEXT_BIND_FAILURE_GUIDANCE =
  "Forgeboard: Docker Desktop could not bind the private per-user context snapshot. Allow file sharing for Forgeboard's app-data folder in Docker Desktop, then retry, or choose the Host runtime.\n";

/**
 * Preserves every provider event while adding one actionable line only when Docker positively
 * identifies this snapshot source as the bind that failed. The result stays terminal and event
 * sequence numbers remain strictly ordered after the inserted guidance.
 */
export function withDockerContextBindFailureGuidance(
  events: AsyncIterable<AgentEvent>,
  snapshotRootPath: string,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      let diagnosticTail = '';
      let sequence = 0;
      let guidanceEmitted = false;
      for await (const event of events) {
        if (event.type === 'stream' && (event.channel === 'stderr' || event.channel === 'pty')) {
          diagnosticTail = boundedTail(diagnosticTail, event.data);
        }
        if (
          event.type === 'result' &&
          event.result.status === 'failed' &&
          !guidanceEmitted &&
          isSnapshotBindDenial(diagnosticTail, snapshotRootPath)
        ) {
          guidanceEmitted = true;
          yield {
            sequence: sequence++,
            timestamp: event.timestamp,
            type: 'stream',
            channel: 'stderr',
            data: DOCKER_CONTEXT_BIND_FAILURE_GUIDANCE,
          };
        }
        yield { ...event, sequence: sequence++ };
      }
    },
  };
}

export function isSnapshotBindDenial(output: string, snapshotRootPath: string): boolean {
  const comparable = normalizeDiagnostic(output);
  if (!snapshotAliases(snapshotRootPath).some((alias) => comparable.includes(alias))) return false;
  return [
    /mounts denied/u,
    /not shared from the host/u,
    /not known to docker/u,
    /invalid mount config[^\n]{0,512}type\s*["']?bind/u,
    /bind source path[^\n]{0,512}(?:does not exist|access is denied|permission denied)/u,
    /error (?:while|during) creating mount source path[^\n]{0,512}(?:access is denied|permission denied)/u,
    /file sharing[^\n]{0,512}(?:denied|disabled|not enabled)/u,
  ].some((pattern) => pattern.test(comparable));
}

function boundedTail(previous: string, next: string): string {
  const combined = previous + next;
  return combined.length <= MAX_MATCH_BUFFER ? combined : combined.slice(-MAX_MATCH_BUFFER);
}

function normalizeDiagnostic(value: string): string {
  return value.toLowerCase().replaceAll('\\', '/');
}

function snapshotAliases(snapshotRootPath: string): string[] {
  const normalized = normalizeDiagnostic(snapshotRootPath).replace(/\/+$/u, '');
  const aliases = new Set([normalized, '/forgeboard-context']);
  const drivePath = /^([a-z]):\/(.*)$/u.exec(normalized);
  if (drivePath !== null) {
    const drive = drivePath[1];
    const rest = drivePath[2];
    aliases.add(`/host_mnt/${drive}/${rest}`);
    aliases.add(`/run/desktop/mnt/host/${drive}/${rest}`);
  }
  return [...aliases].filter((alias) => alias.length > 0);
}
