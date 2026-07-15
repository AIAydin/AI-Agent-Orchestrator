import { AgentEventSchema } from '@forgeboard/agent-adapters';
import { z } from 'zod';

import type { RunEventEnvelope } from '../../../shared/application/contracts.js';
import { WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS } from '../../../shared/workflow/contracts.js';
import type { WorkflowNodeInteractionEvent } from '../host/contracts.js';

const MAX_BUFFERED_EVENTS = 128;
const MAX_BUFFERED_TEXT_CODE_UNITS = 131_072;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ENTRIES = 1_024;

const RunSummarySchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'interrupted', 'terminated']),
    exitCode: z.number().int().nullable(),
  })
  .passthrough();
const RunErrorSchema = z.object({ message: z.string() }).passthrough();

export class WorkflowAgentEventRelay {
  readonly #listeners = new Set<(event: WorkflowNodeInteractionEvent) => void>();
  #buffer: WorkflowNodeInteractionEvent[] = [];
  #bufferedTextCodeUnits = 0;
  #closed = false;

  public push(event: WorkflowNodeInteractionEvent): void {
    if (this.#closed) return;
    if (this.#listeners.size > 0) {
      for (const listener of [...this.#listeners]) {
        try {
          listener(event);
        } catch {
          // One ephemeral observer cannot block delivery to the remaining exact-run observers.
        }
      }
      return;
    }
    this.#buffer.push(event);
    this.#bufferedTextCodeUnits += event.text.length;
    while (
      this.#buffer.length > MAX_BUFFERED_EVENTS ||
      this.#bufferedTextCodeUnits > MAX_BUFFERED_TEXT_CODE_UNITS
    ) {
      const removed = this.#buffer.shift();
      if (removed === undefined) break;
      this.#bufferedTextCodeUnits -= removed.text.length;
    }
  }

  public subscribe(listener: (event: WorkflowNodeInteractionEvent) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    const buffered = this.#buffer;
    this.#buffer = [];
    this.#bufferedTextCodeUnits = 0;
    for (const event of buffered) {
      try {
        listener(event);
      } catch {
        // Buffered output is best effort and cannot invalidate the exact-run subscription.
      }
    }
    return () => this.#listeners.delete(listener);
  }

  public close(): void {
    this.#closed = true;
    this.#listeners.clear();
    this.#buffer = [];
    this.#bufferedTextCodeUnits = 0;
  }
}

export function normalizeWorkflowAgentEvent(
  envelope: RunEventEnvelope,
  expected: { readonly runId: string; readonly nodeId: string },
  sequence: number,
  now: () => Date,
): WorkflowNodeInteractionEvent | undefined {
  if (envelope.runId !== expected.runId || envelope.nodeId !== expected.nodeId) return undefined;
  if (envelope.kind === 'agent-event') {
    const parsed = AgentEventSchema.safeParse(envelope.payload);
    if (!parsed.success) return undefined;
    const event = parsed.data;
    switch (event.type) {
      case 'stream':
        return interaction(sequence, event.timestamp, 'stream', event.data, event.channel);
      case 'lifecycle':
        return interaction(
          sequence,
          event.timestamp,
          'lifecycle',
          event.detail === undefined ? event.phase : `${event.phase}: ${event.detail}`,
          'status',
        );
      case 'message': {
        const text = boundedJsonText(event.payload);
        return interaction(
          sequence,
          event.timestamp,
          'message',
          text.value,
          event.channel,
          text.truncated,
        );
      }
      case 'result':
        return interaction(
          sequence,
          event.timestamp,
          'result',
          `${event.result.status} (exit ${event.result.exitCode === null ? 'none' : String(event.result.exitCode)})`,
          'status',
        );
    }
  }
  if (envelope.kind === 'run-summary') {
    const summary = RunSummarySchema.safeParse(envelope.payload);
    if (!summary.success) return undefined;
    return interaction(
      sequence,
      now().toISOString(),
      'summary',
      `${summary.data.status} (exit ${summary.data.exitCode === null ? 'none' : String(summary.data.exitCode)})`,
      'status',
    );
  }
  const failure = RunErrorSchema.safeParse(envelope.payload);
  if (!failure.success) return undefined;
  return interaction(sequence, now().toISOString(), 'error', failure.data.message, 'status');
}

function interaction(
  sequence: number,
  occurredAt: string,
  kind: WorkflowNodeInteractionEvent['kind'],
  unboundedText: string,
  channel?: WorkflowNodeInteractionEvent['channel'],
  alreadyTruncated = false,
): WorkflowNodeInteractionEvent {
  const text = boundedText(unboundedText);
  return {
    sequence,
    occurredAt,
    kind,
    ...(channel === undefined ? {} : { channel }),
    text: text.value,
    truncated: alreadyTruncated || text.truncated,
  };
}

function boundedJsonText(value: unknown): { readonly value: string; readonly truncated: boolean } {
  try {
    const budget = { entries: 0, codeUnits: 0, truncated: false };
    const normalized = jsonValue(value, 0, budget, new WeakSet<object>());
    if (normalized === undefined) throw new Error('non-json');
    const serialized = boundedText(JSON.stringify(normalized));
    return { value: serialized.value, truncated: budget.truncated || serialized.truncated };
  } catch {
    return { value: '[Non-JSON message payload omitted]', truncated: true };
  }
}

function jsonValue(
  value: unknown,
  depth: number,
  budget: { entries: number; codeUnits: number; truncated: boolean },
  seen: WeakSet<object>,
):
  | null
  | boolean
  | number
  | string
  | readonly unknown[]
  | Readonly<Record<string, unknown>>
  | undefined {
  if (depth > MAX_JSON_DEPTH || budget.entries > MAX_JSON_ENTRIES) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const remaining = Math.max(0, WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS - budget.codeUnits);
    const text = boundedTextTo(value, remaining);
    budget.codeUnits += text.value.length;
    if (value.length > text.value.length) budget.truncated = true;
    return text.value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length + budget.entries > MAX_JSON_ENTRIES) return undefined;
      budget.entries += value.length;
      const output: unknown[] = [];
      for (const entry of value) {
        const parsed = jsonValue(entry, depth + 1, budget, seen);
        if (parsed === undefined) return undefined;
        output.push(parsed);
      }
      return output;
    }
    const prototype: unknown = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length + budget.entries > MAX_JSON_ENTRIES) return undefined;
    budget.entries += keys.length;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      budget.codeUnits += key.length;
      if (budget.codeUnits > WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS) return undefined;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      const parsed = jsonValue(descriptor.value, depth + 1, budget, seen);
      if (parsed === undefined) return undefined;
      output[key] = parsed;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function boundedText(value: string): { readonly value: string; readonly truncated: boolean } {
  return boundedTextTo(value, WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS);
}

function boundedTextTo(
  value: string,
  maximumCodeUnits: number,
): { readonly value: string; readonly truncated: boolean } {
  if (value.length <= maximumCodeUnits) return { value, truncated: false };
  let end = maximumCodeUnits;
  if (end === 0) return { value: '', truncated: value.length > 0 };
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return { value: value.slice(0, end), truncated: true };
}
