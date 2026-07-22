import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

const COMMAND_TIMEOUT_MS = 10_000;

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { message?: string };
  readonly method?: string;
  readonly params?: unknown;
  readonly sessionId?: string;
}

export interface CdpEvent {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId: string | null;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

/** Null-delimited Chrome DevTools Protocol transport over Chrome's private fd 3/4 pipe. */
export class CdpPipeClient {
  readonly #input: Writable;
  readonly #output: Readable;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #eventListeners = new Set<(event: CdpEvent) => void>();
  #nextId = 0;
  #buffer = '';
  #closed = false;

  constructor(child: ChildProcess) {
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (
      input === undefined ||
      output === undefined ||
      input === null ||
      output === null ||
      !('write' in input) ||
      !('on' in output)
    ) {
      throw new Error('Chrome did not expose its private debugging pipe.');
    }
    this.#input = input;
    this.#output = output as Readable;
    this.#output.setEncoding('utf8');
    this.#output.on('data', (chunk: string) => this.#receive(chunk));
    this.#output.once('error', (error) => this.close(error));
    child.once('exit', () => this.close(new Error('Chrome closed.')));
  }

  async send<Result>(method: string, params: unknown = {}, sessionId?: string): Promise<Result> {
    if (this.#closed) throw new Error('Chrome connection is closed.');
    const id = ++this.#nextId;
    const message = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return await new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chrome command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
        timeout,
      });
      this.#input.write(`${message}\0`, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  close(error = new Error('Chrome connection closed.')): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#eventListeners.clear();
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    const messages = this.#buffer.split('\0');
    this.#buffer = messages.pop() ?? '';
    for (const raw of messages) {
      if (raw === '') continue;
      let message: CdpResponse;
      try {
        message = JSON.parse(raw) as CdpResponse;
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) continue;
        clearTimeout(pending.timeout);
        this.#pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new Error(message.error.message ?? 'Chrome command failed.'));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (message.method === undefined) continue;
      const event: CdpEvent = {
        method: message.method,
        params: message.params,
        sessionId: message.sessionId ?? null,
      };
      for (const listener of this.#eventListeners) listener(event);
    }
  }
}
