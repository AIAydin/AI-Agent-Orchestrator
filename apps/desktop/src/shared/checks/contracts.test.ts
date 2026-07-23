import { describe, expect, it } from 'vitest';

import {
  CheckCancelInputSchema,
  CheckEventEnvelopeSchema,
  CheckExecutionViewSchema,
  CheckIdSchema,
  CheckListInputSchema,
  CheckPlanConfirmationInputSchema,
  CheckPlanViewSchema,
  CheckPrepareInputSchema,
} from './contracts.js';
import { AppSettingsSchema, CustomChecksSchema } from '../application/contracts.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '10000000-0000-4000-8000-000000000002';
const EXECUTION_ID = '10000000-0000-4000-8000-000000000003';
const NOW = '2026-07-15T12:00:00.000Z';
const LATER = '2026-07-15T12:01:00.000Z';

const plan = {
  planId: PLAN_ID,
  projectId: PROJECT_ID,
  checkId: 'lint' as const,
  label: 'Lint',
  kind: 'lint' as const,
  executable: 'pnpm',
  arguments: ['lint'],
  cwd: '/tmp/project',
  environmentVariableNames: ['PATH'],
  approvalFingerprint: 'a'.repeat(64),
  expiresAt: NOW,
};

const execution = {
  id: EXECUTION_ID,
  projectId: PROJECT_ID,
  checkId: 'lint' as const,
  label: 'Lint',
  kind: 'lint' as const,
  executable: 'pnpm',
  arguments: ['lint'],
  cwd: '/tmp/project',
  environmentVariableNames: ['PATH'],
  status: 'queued' as const,
  exitCode: null,
  startedAt: null,
  endedAt: null,
  output: '',
  outputTruncated: false,
  updatedAt: NOW,
};

describe('project check IPC contracts', () => {
  it('keeps renderer requests strict and confirmation explicit', () => {
    expect(CheckPrepareInputSchema.parse({ projectId: PROJECT_ID, checkId: 'lint' })).toEqual({
      projectId: PROJECT_ID,
      checkId: 'lint',
    });
    expect(
      CheckPrepareInputSchema.safeParse({
        projectId: PROJECT_ID,
        checkId: 'lint',
        executable: '/renderer/chosen',
      }).success,
    ).toBe(false);
    expect(CheckPlanConfirmationInputSchema.parse({ planId: PLAN_ID, confirmed: true })).toEqual({
      planId: PLAN_ID,
      confirmed: true,
    });
    expect(CheckPlanConfirmationInputSchema.parse({ planId: PLAN_ID, confirmed: false })).toEqual({
      planId: PLAN_ID,
      confirmed: false,
    });
    expect(CheckListInputSchema.safeParse({ projectId: PROJECT_ID, limit: 100 }).success).toBe(
      false,
    );
    expect(CheckCancelInputSchema.parse({ executionId: EXECUTION_ID })).toEqual({
      executionId: EXECUTION_ID,
    });
  });

  it('accepts only fixed built-in IDs or UUID custom IDs with matching kinds', () => {
    expect(CheckIdSchema.safeParse('typecheck').success).toBe(true);
    expect(CheckIdSchema.safeParse(EXECUTION_ID).success).toBe(true);
    expect(CheckIdSchema.safeParse('arbitrary-shell-command').success).toBe(false);
    expect(CheckPlanViewSchema.parse(plan)).toEqual(plan);
    expect(CheckPlanViewSchema.safeParse({ ...plan, kind: 'test' }).success).toBe(false);
    expect(
      CheckPlanViewSchema.safeParse({ ...plan, checkId: EXECUTION_ID, kind: 'custom' }).success,
    ).toBe(true);
    expect(CheckPlanViewSchema.safeParse({ ...plan, unexpected: true }).success).toBe(false);
  });

  it('bounds executable details, output, and project-scoped events', () => {
    expect(CheckExecutionViewSchema.parse(execution)).toEqual(execution);
    expect(
      CheckExecutionViewSchema.safeParse({ ...execution, output: 'x'.repeat(1_048_577) }).success,
    ).toBe(false);
    expect(
      CheckExecutionViewSchema.safeParse({ ...execution, output: '💥'.repeat(300_000) }).success,
    ).toBe(false);
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        environmentVariableNames: ['PATH', 'PATH'],
      }).success,
    ).toBe(false);
    expect(
      CheckExecutionViewSchema.safeParse({ ...execution, arguments: Array(513).fill('x') }).success,
    ).toBe(false);
    expect(CheckEventEnvelopeSchema.parse({ projectId: PROJECT_ID, execution })).toEqual({
      projectId: PROJECT_ID,
      execution,
    });
    expect(
      CheckEventEnvelopeSchema.safeParse({
        projectId: '20000000-0000-4000-8000-000000000001',
        execution,
      }).success,
    ).toBe(false);
  });

  it('requires status, exit-code, and lifecycle timestamps to agree', () => {
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        status: 'running',
        startedAt: NOW,
        updatedAt: LATER,
      }).success,
    ).toBe(true);
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        status: 'lost',
        endedAt: LATER,
        updatedAt: LATER,
      }).success,
    ).toBe(true);
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        status: 'failed',
        endedAt: LATER,
        updatedAt: LATER,
      }).success,
    ).toBe(true);
    expect(CheckExecutionViewSchema.safeParse({ ...execution, startedAt: NOW }).success).toBe(
      false,
    );
    expect(CheckExecutionViewSchema.safeParse({ ...execution, status: 'running' }).success).toBe(
      false,
    );
    expect(CheckExecutionViewSchema.safeParse({ ...execution, endedAt: NOW }).success).toBe(false);
    expect(CheckExecutionViewSchema.safeParse({ ...execution, exitCode: 1 }).success).toBe(false);
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        status: 'passed',
        exitCode: 1,
        endedAt: LATER,
        updatedAt: LATER,
      }).success,
    ).toBe(false);
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        status: 'failed',
        exitCode: 0,
        endedAt: LATER,
        updatedAt: LATER,
      }).success,
    ).toBe(false);
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        status: 'cancelled',
        startedAt: LATER,
        endedAt: NOW,
        updatedAt: LATER,
      }).success,
    ).toBe(false);
    expect(
      CheckExecutionViewSchema.safeParse({
        ...execution,
        status: 'lost',
        endedAt: LATER,
      }).success,
    ).toBe(false);
  });
});

describe('custom check settings contracts', () => {
  const customCheck = {
    id: EXECUTION_ID,
    label: 'Architecture check',
    command: { executable: 'pnpm', arguments: ['check:architecture'] },
  };

  it('accepts an optional bounded list with unique UUID identities', () => {
    expect(CustomChecksSchema.parse([customCheck])).toEqual([customCheck]);
    expect(CustomChecksSchema.safeParse([{ ...customCheck, unexpected: true }]).success).toBe(
      false,
    );
    expect(CustomChecksSchema.safeParse([customCheck, customCheck]).success).toBe(false);
    expect(CustomChecksSchema.safeParse(Array(33).fill(customCheck)).success).toBe(false);

    const settings = {
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'codex',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: '/tmp/forgeboard-worktrees',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      previewPortStart: 41_000,
      previewPortEnd: 41_999,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: 'ws://127.0.0.1:1234',
      customChecks: [customCheck],
    } as const;
    expect(AppSettingsSchema.parse(settings).customChecks).toEqual([customCheck]);
    expect(AppSettingsSchema.parse({ ...settings, customChecks: undefined }).customChecks).toBe(
      undefined,
    );
  });
});
