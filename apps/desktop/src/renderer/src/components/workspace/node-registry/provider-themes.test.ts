import { describe, expect, it } from 'vitest';
import { providerTheme } from './provider-themes.js';

describe('providerTheme', () => {
  it('themes the known first-party providers', () => {
    expect(providerTheme('claude')?.label).toBe('Claude Code');
    expect(providerTheme('claude')?.accent).toBe('#d97757');
    expect(providerTheme('codex')?.label).toBe('Codex');
    expect(providerTheme('gemini')?.accent).toBe('#4e86f6');
    expect(providerTheme('opencode')?.label).toBe('opencode');
  });

  it('returns null for unknown or missing adapters', () => {
    expect(providerTheme(undefined)).toBeNull();
    expect(providerTheme('extension:acme:1.0.0:bot')).toBeNull();
  });
});
