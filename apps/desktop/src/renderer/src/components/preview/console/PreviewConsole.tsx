import type { PreviewSessionSnapshot } from '../../../../../shared/application/contracts.js';
import type {
  PreviewConsoleEntry,
  PreviewConsoleView,
} from '../../../../../shared/preview/surface/contracts.js';
import './PreviewConsole.css';

const MAX_RENDERED_LOG_CHARACTERS = 128 * 1024;

interface PreviewConsoleProps {
  session: PreviewSessionSnapshot | null;
  browserConsole?: PreviewConsoleView | null;
}

export function PreviewConsole({ session, browserConsole = null }: PreviewConsoleProps) {
  const surfaceEntries: readonly PreviewConsoleEntry[] = browserConsole?.entries ?? [];
  const processOutput = (session?.processes ?? []).flatMap((process) =>
    process.logs.map((log) => ({
      key: `${process.id}:${String(log.sequence)}`,
      timestamp: log.timestamp,
      line: `[${log.stream}] ${log.data}`,
    })),
  );
  const browserOutput = surfaceEntries.map((entry) => ({
    key: `browser:${String(entry.sequence)}`,
    timestamp: entry.capturedAt,
    line: `[browser:${entry.level}] ${entry.message}\n`,
  }));
  const processText = orderedText(processOutput);
  const browserText = orderedText(browserOutput);
  const processBound = boundTail(processText, MAX_RENDERED_LOG_CHARACTERS / 2);
  const browserBound = boundTail(browserText, MAX_RENDERED_LOG_CHARACTERS / 2);
  const combined = processText + browserText;
  const rendered = processBound.value + browserBound.value;
  const truncated = processBound.truncated || browserBound.truncated;
  const errorCount = surfaceEntries.filter((entry) => entry.level === 'error').length;

  return (
    <details className="preview-console" open={session?.status === 'failed'}>
      <summary>
        Console &amp; errors
        <span>
          {errorCount ? `${String(errorCount)} browser errors · ` : ''}
          {formatBytes(
            browserConsole?.retainedBytes ?? new TextEncoder().encode(combined).byteLength,
          )}{' '}
          kept
        </span>
      </summary>
      {truncated || browserConsole?.truncated ? (
        <p className="preview-console-truncated" role="status">
          Older output is hidden to keep this view small.
        </p>
      ) : null}
      <pre aria-label="Preview console output">{rendered || 'Nothing logged yet.'}</pre>
    </details>
  );
}

function orderedText(entries: readonly { key: string; timestamp: string; line: string }[]): string {
  return [...entries]
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) || left.key.localeCompare(right.key),
    )
    .map((entry) => entry.line)
    .join('');
}

function boundTail(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false };
  return { value: value.slice(-limit), truncated: true };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}
