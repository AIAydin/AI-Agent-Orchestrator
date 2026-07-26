// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import {
  ClaudeLogo,
  DockerLogo,
  GeminiLogo,
  GithubLogo,
  OpenAiLogo,
  OpencodeLogo,
  providerBrandLogo,
} from './brand-logos.js';

afterEach(cleanup);

describe('brand logos', () => {
  it.each([
    ['OpenAI', OpenAiLogo],
    ['Claude', ClaudeLogo],
    ['Gemini', GeminiLogo],
    ['OpenCode', OpencodeLogo],
    ['GitHub', GithubLogo],
    ['Docker', DockerLogo],
  ] as const)('renders the %s mark as decorative currentColor SVG', (_name, Logo) => {
    const { container } = render(<Logo size={18} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
    expect(svg?.getAttribute('width')).toBe('18');
    expect(svg?.getAttribute('height')).toBe('18');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBeTruthy();
  });

  it('maps built-in adapters to their brand marks', () => {
    expect(providerBrandLogo('codex')).toBe(OpenAiLogo);
    expect(providerBrandLogo('claude')).toBe(ClaudeLogo);
    expect(providerBrandLogo('gemini')).toBe(GeminiLogo);
    expect(providerBrandLogo('opencode')).toBe(OpencodeLogo);
  });

  it('returns null for unknown or missing adapters', () => {
    expect(providerBrandLogo(undefined)).toBeNull();
    expect(providerBrandLogo('extension:acme:1.0.0:bot')).toBeNull();
  });
});
