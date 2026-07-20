// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { AgentSessionProvider, useAgentSession, type AgentSessionContextValue } from './AgentSessionContext.js';

describe('useAgentSession', () => {
  it('throws without a provider', () => {
    expect(() => renderHook(() => useAgentSession())).toThrow(/AgentSessionProvider/);
  });

  it('returns the provided value', () => {
    const value = { graphReadOnly: true } as unknown as AgentSessionContextValue;
    const { result } = renderHook(() => useAgentSession(), {
      wrapper: ({ children }) => <AgentSessionProvider value={value}>{children}</AgentSessionProvider>,
    });
    expect(result.current.graphReadOnly).toBe(true);
  });
});
