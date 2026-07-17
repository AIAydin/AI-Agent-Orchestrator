import { describe, expect, it } from 'vitest';

import type { AgentDetection } from '../../../../../../shared/application/contracts.js';
import { effectiveNodeModel } from './model-selection.js';

const capabilities = {
  interactiveInput: true,
  interrupt: true,
  pause: false,
  resume: true,
  modelSelection: true,
};

describe('effectiveNodeModel', () => {
  it('prefers a trimmed node override for an adapter that declares model selection', () => {
    expect(effectiveNodeModel(agent(true), '  gpt-5.1  ', 'gpt-5')).toBe('gpt-5.1');
  });

  it('fails closed for unsupported or unknown adapter capabilities', () => {
    expect(effectiveNodeModel(agent(false), 'gpt-5.1', 'gpt-5')).toBeUndefined();
    expect(effectiveNodeModel(undefined, 'gpt-5.1', 'gpt-5')).toBeUndefined();
  });
});

function agent(modelSelection: boolean): Pick<AgentDetection, 'capabilities'> {
  return { capabilities: { ...capabilities, modelSelection } };
}
