import { useMemo, useState } from 'react';
import { Send, StopCircle } from 'lucide-react';

import {
  WORKFLOW_NODE_INPUT_MAX_CODE_UNITS,
  type WorkflowInteractionEventEnvelope,
  type WorkflowNodeInput,
  type WorkflowNodeInterrupt,
} from '../../../../../shared/workflow/contracts.js';

interface WorkflowNodeTerminalProps {
  executionId: string;
  nodeId: string;
  attempt: number;
  title: string;
  events: readonly WorkflowInteractionEventEnvelope[];
  busy: boolean;
  onSendInput: (input: WorkflowNodeInput) => Promise<boolean>;
  onInterrupt: (input: WorkflowNodeInterrupt) => Promise<boolean>;
}

export function WorkflowNodeTerminal({
  executionId,
  nodeId,
  attempt,
  title,
  events,
  busy,
  onSendInput,
  onInterrupt,
}: WorkflowNodeTerminalProps) {
  const [input, setInput] = useState('');
  const output = useMemo(
    () =>
      events
        .map((event) => {
          const prefix = event.channel === undefined ? '' : `[${event.channel}] `;
          return `${prefix}${event.text}${event.truncated ? '…' : ''}`;
        })
        .join('\n'),
    [events],
  );

  async function send(): Promise<void> {
    if (input.length === 0 || input.includes('\0')) return;
    const accepted = await onSendInput({ executionId, nodeId, attempt, data: input });
    if (accepted) setInput('');
  }

  return (
    <section className="workflow-node-terminal" aria-label={`Live controls for ${title}`}>
      <pre aria-label={`Live output for ${title}`} aria-live="polite">
        {output === '' ? 'Waiting for live output…' : output}
      </pre>
      <label>
        <span>Send input to the running program</span>
        <textarea
          name="workflow-node-input"
          value={input}
          maxLength={WORKFLOW_NODE_INPUT_MAX_CODE_UNITS}
          rows={2}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setInput(event.target.value)}
        />
      </label>
      <small>Input goes only to this attempt and is never saved in the workflow history.</small>
      <div>
        <button type="button" disabled={busy || input.length === 0} onClick={() => void send()}>
          <Send size={11} aria-hidden="true" /> Send
        </button>
        <button
          type="button"
          className="workflow-interrupt"
          disabled={busy}
          onClick={() => void onInterrupt({ executionId, nodeId, attempt })}
        >
          <StopCircle size={11} aria-hidden="true" /> Stop
        </button>
      </div>
    </section>
  );
}
