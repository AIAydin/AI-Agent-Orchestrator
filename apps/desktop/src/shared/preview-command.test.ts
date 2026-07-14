import { describe, expect, it } from 'vitest';

import type { GitHealth } from './contracts.js';
import { detectedPreviewScripts, preferredPreviewScript } from './preview-command.js';

function health(overrides: Partial<GitHealth> = {}): GitHealth {
  return {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'pnpm',
    frameworks: ['Vite'],
    scripts: { test: 'vitest', dev: 'vite --host 0.0.0.0' },
    hasSubmodules: false,
    sensitiveWarnings: [],
    ...overrides,
  };
}

describe('preview package-script discovery', () => {
  it('builds an argument-array command without parsing the declaration', () => {
    const scripts = detectedPreviewScripts(health());

    expect(scripts).toEqual([
      {
        name: 'test',
        declaration: 'vitest',
        executable: 'pnpm',
        arguments: ['run', 'test'],
      },
      {
        name: 'dev',
        declaration: 'vite --host 0.0.0.0',
        executable: 'pnpm',
        arguments: ['run', 'dev'],
      },
    ]);
    expect(preferredPreviewScript(scripts)).toBe('dev');
  });

  it('filters option-shaped names and needs a known package manager', () => {
    expect(
      detectedPreviewScripts(
        health({ scripts: { '--help': 'touch should-not-run', 'dev:web': 'vite' } }),
      ).map((script) => script.name),
    ).toEqual(['dev:web']);
    expect(detectedPreviewScripts(health({ packageManager: 'unknown' }))).toEqual([]);
  });
});
