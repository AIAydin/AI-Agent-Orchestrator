import { StringDecoder } from 'node:string_decoder';

import type { WorkflowNodeInteractionEvent } from '../../host/contracts.js';

const MAX_TEXT = 32_768;
const MAX_EVENTS = 512;
const MAX_RETAINED = 256 * 1024;

export class ExactCheckInteractionRelay {
  readonly #listeners = new Set<(event: WorkflowNodeInteractionEvent) => void>();
  readonly #events: WorkflowNodeInteractionEvent[] = [];
  readonly #decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  #sequence = 0;
  #retained = 0;
  #closed = false;
  public constructor(private readonly now: () => Date) {}

  public write(stream: 'stdout' | 'stderr', data: Buffer): void {
    if (!this.#closed) this.#emit('stream', stream, this.#decoders[stream].write(data));
  }
  public lifecycle(text: string): void {
    this.#emit('lifecycle', 'status', text);
  }
  public finish(text: string): void {
    if (this.#closed) return;
    this.#emit('stream', 'stdout', this.#decoders.stdout.end());
    this.#emit('stream', 'stderr', this.#decoders.stderr.end());
    this.#emit('result', 'status', text);
    this.#closed = true;
  }
  public subscribe(listener: (event: WorkflowNodeInteractionEvent) => void): () => void {
    for (const event of this.#events) listener({ ...event });
    if (!this.#closed) this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(
    kind: WorkflowNodeInteractionEvent['kind'],
    channel: NonNullable<WorkflowNodeInteractionEvent['channel']>,
    text: string,
  ): void {
    for (let offset = 0; offset < text.length; offset += MAX_TEXT) {
      const event: WorkflowNodeInteractionEvent = {
        sequence: this.#sequence++,
        occurredAt: this.now().toISOString(),
        kind,
        channel,
        text: text.slice(offset, offset + MAX_TEXT),
        truncated: offset + MAX_TEXT < text.length,
      };
      this.#events.push(event);
      this.#retained += event.text.length;
      while (this.#events.length > MAX_EVENTS || this.#retained > MAX_RETAINED) {
        const removed = this.#events.shift();
        if (removed === undefined) break;
        this.#retained -= removed.text.length;
      }
      for (const listener of this.#listeners) listener({ ...event });
    }
  }
}
