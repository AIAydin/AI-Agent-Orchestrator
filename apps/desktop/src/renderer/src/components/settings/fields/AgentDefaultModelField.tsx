import { useState } from 'react';

import { knownAgentModels } from '../../../lib/agent-models.js';

/** Select value that reveals the free-text model input. Never a real model id. */
export const CUSTOM_MODEL_CHOICE = '__custom-model__';

interface AgentDefaultModelFieldProps {
  readonly agentId: string;
  /** Name of the original free-text input; the select gets `${name}-choice`. */
  readonly name: string;
  readonly value: string;
  readonly onChange: (model: string) => void;
}

/**
 * "Default model (optional)" picker: a select seeded with the known model ids
 * for the agent plus a Custom… choice that reveals the original free-text
 * input, so arbitrary ids stay possible and previously saved custom values
 * remain visible.
 */
export function AgentDefaultModelField({
  agentId,
  name,
  value,
  onChange,
}: AgentDefaultModelFieldProps) {
  const models = knownAgentModels(agentId);
  const listed = value === '' || models.includes(value);
  const [customChosen, setCustomChosen] = useState(!listed);
  const custom = customChosen || !listed;
  return (
    <>
      <label>
        Default model (optional)
        <select
          name={`${name}-choice`}
          value={custom ? CUSTOM_MODEL_CHOICE : value}
          onChange={(event) => {
            if (event.target.value === CUSTOM_MODEL_CHOICE) {
              setCustomChosen(true);
              return;
            }
            setCustomChosen(false);
            onChange(event.target.value);
          }}
        >
          <option value="">Tool's usual model (default)</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
          <option value={CUSTOM_MODEL_CHOICE}>Custom…</option>
        </select>
      </label>
      {custom && (
        <label>
          Custom model id
          <input
            name={name}
            value={value}
            placeholder="Exact model id the tool should use"
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
    </>
  );
}
