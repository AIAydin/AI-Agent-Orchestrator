import { createInterface } from 'node:readline';
import { handleMessage, type HubClient } from './protocol.js';

/**
 * Runs the line-delimited JSON-RPC loop over `input`/`output`. Each line
 * spawns an async handler; those handlers are tracked in `pending` so that
 * when `input` closes (stdin EOF), replies for requests still in flight —
 * e.g. a `tools/call` whose hub fetch hasn't resolved yet — are drained
 * before `onDone` fires. `onDone` always runs, regardless of whether any
 * individual handler failed.
 */
export function createStdioLoop(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  hub: HubClient,
  onDone: () => void,
): void {
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input });

  lines.on('line', (line) => {
    if (line.trim() === '') return;
    const task = (async (): Promise<void> => {
      let parsed: Parameters<typeof handleMessage>[0];
      try {
        parsed = JSON.parse(line) as Parameters<typeof handleMessage>[0];
      } catch {
        return;
      }
      try {
        const reply = await handleMessage(parsed, hub);
        if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
      } catch {
        // handleMessage already converts hub failures into isError replies
        // for tools/call; this is a last-resort guard so one bad request can
        // never leave a rejected promise blocking the drain below.
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task));
  });

  lines.on('close', () => {
    void Promise.allSettled([...pending]).then(() => onDone());
  });
}
