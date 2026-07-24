import { describe, expect, it } from 'vitest';

import {
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_OUTPUT_CHUNK_BYTES,
  TerminalChooseExecutableInputSchema,
  TerminalEventSchema,
  TerminalExecutableSelectionViewSchema,
  TerminalInputSchema,
  TerminalLaunchPlanViewSchema,
  TerminalOutputChunkSchema,
  TerminalPrepareLaunchInputSchema,
  TerminalReplayViewSchema,
  TerminalSessionViewSchema,
  TerminalWorkspaceRequestSchema,
  TerminalWorkspaceViewSchema,
  type TerminalLaunchPlanView,
  type TerminalSessionView,
} from './index.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const SESSION_ID = '30000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T16:00:00.000Z';

const PERMISSION = {
  label: 'Local process',
  sandboxed: false as const,
  filesystem: 'operating-system-user' as const,
  network: 'operating-system-user' as const,
  detail: 'The working directory limits context but is not a security sandbox.',
};

const PLAN: TerminalLaunchPlanView = {
  kind: 'terminal-launch',
  planId: PLAN_ID,
  projectId: PROJECT_ID,
  projectName: 'Forgeboard',
  nodeId: 'terminal-1',
  executable: '/bin/zsh',
  arguments: ['-l'],
  cwdRelative: 'packages/core',
  environmentVariableNames: ['HOME', 'LANG', 'PATH', 'TERM'],
  columns: 120,
  rows: 36,
  permission: PERMISSION,
  expiresAt: '2026-07-17T16:10:00.000Z',
};

const SESSION: TerminalSessionView = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  nodeId: 'terminal-1',
  executable: '/bin/zsh',
  arguments: ['-l'],
  cwdRelative: 'packages/core',
  environmentVariableNames: ['HOME', 'LANG', 'PATH', 'TERM'],
  columns: 120,
  rows: 36,
  permission: PERMISSION,
  status: 'running',
  startedAt: NOW,
  endedAt: null,
  exitCode: null,
  exitSignal: null,
  earliestSequence: 1,
  nextSequence: 2,
  outputTruncated: false,
  updatedAt: NOW,
};

describe('terminal IPC contracts', () => {
  it('admits exact literal launch configuration and rejects renderer authority or paths as cwd', () => {
    const input = {
      projectId: PROJECT_ID,
      nodeId: 'terminal-1',
      executable: '/Applications/Utilities/Terminal helper',
      arguments: ['--literal', '$(never-run)', 'line one\nline two'],
      cwdRelative: 'apps/desktop',
      environmentVariableNames: ['HOME', 'PATH'],
      columns: 100,
      rows: 30,
    };

    expect(TerminalPrepareLaunchInputSchema.parse(input)).toEqual(input);
    expect(
      TerminalPrepareLaunchInputSchema.safeParse({
        ...input,
        cwdRelative: '/private/project',
      }).success,
    ).toBe(false);
    expect(
      TerminalPrepareLaunchInputSchema.safeParse({
        ...input,
        cwdRelative: '../outside',
      }).success,
    ).toBe(false);
    expect(
      TerminalPrepareLaunchInputSchema.safeParse({
        ...input,
        ownerId: 'renderer-owner',
      }).success,
    ).toBe(false);
    expect(
      TerminalPrepareLaunchInputSchema.safeParse({
        ...input,
        environmentVariableNames: ['Path', 'PATH'],
      }).success,
    ).toBe(false);
    expect(
      TerminalPrepareLaunchInputSchema.safeParse({
        ...input,
        arguments: ['bad\0argument'],
      }).success,
    ).toBe(false);
  });

  it('keeps managed worktree requests and views path-free', () => {
    expect(
      TerminalWorkspaceRequestSchema.parse({
        kind: 'managed-agent-worktree',
        adapterId: 'claude',
      }),
    ).toEqual({
      kind: 'managed-agent-worktree',
      adapterId: 'claude',
    });
    expect(
      TerminalWorkspaceRequestSchema.safeParse({
        kind: 'managed-agent-worktree',
        adapterId: 'claude',
        rootPath: '/private/renderer-selected-worktree',
      }).success,
    ).toBe(false);
    expect(
      TerminalWorkspaceViewSchema.parse({
        kind: 'managed-agent-worktree',
        runId: SESSION_ID,
        branch: 'forgeboard/claude/terminal-1',
      }),
    ).toEqual({
      kind: 'managed-agent-worktree',
      runId: SESSION_ID,
      branch: 'forgeboard/claude/terminal-1',
    });
    expect(
      TerminalWorkspaceViewSchema.safeParse({
        kind: 'managed-agent-worktree',
        runId: SESSION_ID,
        branch: 'forgeboard/claude/terminal-1',
        rootPath: '/private/main-resolved-worktree',
      }).success,
    ).toBe(false);
  });

  it('permits only the user-configured executable path in launch-facing renderer views', () => {
    expect(TerminalLaunchPlanViewSchema.parse(PLAN)).toEqual(PLAN);
    expect(
      TerminalExecutableSelectionViewSchema.parse({
        executable: '/opt/homebrew/bin/fish',
        filename: 'fish',
      }),
    ).toEqual({ executable: '/opt/homebrew/bin/fish', filename: 'fish' });
    expect(
      TerminalLaunchPlanViewSchema.safeParse({
        ...PLAN,
        resolvedCwd: '/private/project',
      }).success,
    ).toBe(false);
    expect(
      TerminalExecutableSelectionViewSchema.safeParse({
        executable: '/bin/zsh',
        filename: '/bin/zsh',
      }).success,
    ).toBe(false);
    expect(
      TerminalChooseExecutableInputSchema.safeParse({
        projectId: PROJECT_ID,
        nodeId: 'terminal-1',
        defaultPath: '/bin/zsh',
      }).success,
    ).toBe(false);
  });

  it('enforces coherent active and terminal session state without owner or storage paths', () => {
    expect(TerminalSessionViewSchema.parse(SESSION)).toEqual(SESSION);
    expect(TerminalSessionViewSchema.safeParse({ ...SESSION, endedAt: NOW }).success).toBe(false);
    expect(
      TerminalSessionViewSchema.safeParse({
        ...SESSION,
        status: 'exited',
        endedAt: NOW,
        exitCode: 0,
      }).success,
    ).toBe(true);
    expect(
      TerminalSessionViewSchema.safeParse({
        ...SESSION,
        status: 'lost',
        endedAt: null,
      }).success,
    ).toBe(false);
    expect(
      TerminalSessionViewSchema.safeParse({
        ...SESSION,
        transcriptPath: '/private/transcript',
      }).success,
    ).toBe(false);
    expect(
      TerminalSessionViewSchema.safeParse({
        ...SESSION,
        ownerId: 'renderer-owner',
      }).success,
    ).toBe(false);
  });

  it('bounds input and output by UTF-8 bytes and rejects NUL', () => {
    expect(
      TerminalInputSchema.safeParse({
        sessionId: SESSION_ID,
        data: 'echo safe\r',
      }).success,
    ).toBe(true);
    expect(
      TerminalInputSchema.safeParse({
        sessionId: SESSION_ID,
        data: 'bad\0input',
      }).success,
    ).toBe(false);
    expect(
      TerminalInputSchema.safeParse({
        sessionId: SESSION_ID,
        data: 'x'.repeat(TERMINAL_MAX_INPUT_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      TerminalOutputChunkSchema.safeParse({
        sequence: 1,
        data: '🧪'.repeat(TERMINAL_MAX_OUTPUT_CHUNK_BYTES / 2),
        occurredAt: NOW,
      }).success,
    ).toBe(false);
  });

  it('admits only ordered, bounded replay chunks inside the retained sequence window', () => {
    const chunks = [
      { sequence: 1, data: 'first\r\n', occurredAt: NOW },
      { sequence: 2, data: 'second\r\n', occurredAt: NOW },
    ];
    const replay = {
      session: { ...SESSION, nextSequence: 3 },
      chunks,
      nextAfterSequence: 2,
      hasMore: false,
    };
    expect(TerminalReplayViewSchema.parse(replay)).toEqual(replay);
    expect(
      TerminalReplayViewSchema.safeParse({
        ...replay,
        chunks: [chunks[1], chunks[0]],
      }).success,
    ).toBe(false);

    const oversizedChunks = Array.from({ length: 17 }, (_, index) => ({
      sequence: index + 1,
      data: 'x'.repeat(TERMINAL_MAX_OUTPUT_CHUNK_BYTES),
      occurredAt: NOW,
    }));
    expect(
      TerminalReplayViewSchema.safeParse({
        session: { ...SESSION, nextSequence: 18 },
        chunks: oversizedChunks,
        nextAfterSequence: 17,
        hasMore: false,
      }).success,
    ).toBe(false);
  });

  it('validates path-free owner-safe output and state events', () => {
    expect(
      TerminalEventSchema.parse({
        kind: 'output',
        projectId: PROJECT_ID,
        nodeId: 'terminal-1',
        sessionId: SESSION_ID,
        chunk: { sequence: 1, data: 'ready\r\n', occurredAt: NOW },
      }),
    ).toBeTruthy();
    expect(
      TerminalEventSchema.safeParse({
        kind: 'session',
        projectId: '40000000-0000-4000-8000-000000000001',
        nodeId: 'terminal-1',
        session: SESSION,
      }).success,
    ).toBe(false);
    expect(
      TerminalEventSchema.safeParse({
        kind: 'output',
        projectId: PROJECT_ID,
        nodeId: 'terminal-1',
        sessionId: SESSION_ID,
        ownerId: 'renderer-owner',
        chunk: { sequence: 1, data: 'ready\r\n', occurredAt: NOW },
      }).success,
    ).toBe(false);
  });
});
