import { describe, expect, it } from 'vitest';

import {
  CommandReadinessRequestSchema,
  CommandReadinessResultSchema,
  commandReadinessMatches,
} from './contracts.js';

const request = CommandReadinessRequestSchema.parse({
  purpose: 'check',
  command: { executable: 'pnpm', arguments: ['run', 'test'] },
  projectId: '10000000-0000-4000-8000-000000000001',
});

describe('command readiness contracts', () => {
  it('keeps literal argv and project context bounded without environment values', () => {
    expect(request).toEqual({
      purpose: 'check',
      command: { executable: 'pnpm', arguments: ['run', 'test'] },
      projectId: '10000000-0000-4000-8000-000000000001',
    });
    expect(
      CommandReadinessRequestSchema.safeParse({
        ...request,
        environment: { SECRET: 'value' },
      }).success,
    ).toBe(false);
  });

  it('requires exact ready-state and reason semantics', () => {
    const result = CommandReadinessResultSchema.parse({
      schemaVersion: 1,
      request,
      state: 'ready',
      ready: true,
      validationScope: 'project',
      resolvedExecutable: '/usr/local/bin/pnpm',
      projectName: 'Artemis',
      checkedAt: '2026-07-15T18:00:00.000Z',
      reason: null,
      warning: null,
    });
    expect(commandReadinessMatches(result, request)).toBe(true);
    expect(
      CommandReadinessResultSchema.safeParse({
        ...result,
        state: 'executable-missing',
        reason: null,
      }).success,
    ).toBe(false);
  });

  it('invalidates evidence when any literal argument changes', () => {
    const result = CommandReadinessResultSchema.parse({
      schemaVersion: 1,
      request,
      state: 'ready-without-project',
      ready: true,
      validationScope: 'executable',
      resolvedExecutable: '/usr/local/bin/pnpm',
      projectName: null,
      checkedAt: '2026-07-15T18:00:00.000Z',
      reason: null,
      warning: 'Open a project to validate the package script.',
    });
    expect(
      commandReadinessMatches(result, {
        ...request,
        command: { ...request.command, arguments: ['run', 'build'] },
      }),
    ).toBe(false);
  });
});
