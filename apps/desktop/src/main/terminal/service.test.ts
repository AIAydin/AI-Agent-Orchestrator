import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppSettings, Project } from '../../shared/application/contracts.js';
import type {
  TerminalEvent,
  TerminalPrepareLaunchInput,
  TerminalSessionView,
} from '../../shared/terminal/index.js';
import { formatPeerDelivery } from '../agent-peers/text.js';
import {
  terminalStorageRecord,
  type StoredTerminalSession,
} from '../storage/terminal/contracts.js';
import type { TerminalPtyExit, TerminalPtyHandle } from './pty-process.js';
import { TerminalService, splitTerminalOutput, type TerminalServiceStore } from './service.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const SESSION_ID = '30000000-0000-4000-8000-000000000001';
const UNKNOWN_SESSION_ID = '40000000-0000-4000-8000-000000000001';

describe('TerminalService', () => {
  const services: TerminalService[] = [];

  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map(async (service) => await service.dispose()));
  });

  it('launches once after exact native review and keeps exact history owner-private', async () => {
    const harness = await fixture();
    const events: { ownerId: string; event: TerminalEvent }[] = [];
    harness.service.subscribe((ownerId, event) => events.push({ ownerId, event }));
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);
    let reviewedExecutable = '';
    const session = await harness.service.confirmLaunch('owner-a', plan.planId, (review) => {
      reviewedExecutable = review.exact.executable;
      return Promise.resolve('approved');
    });

    expect(session).toMatchObject({
      id: SESSION_ID,
      status: 'running',
      arguments: ['-l'],
    });
    expect(reviewedExecutable).toBe(await realpath('/bin/sh'));
    await expect(
      harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow(/missing, expired/u);

    expect(await harness.service.listSessions('owner-a', { projectId: PROJECT_ID })).toMatchObject([
      { executable: '/bin/sh', arguments: ['-l'] },
    ]);
    expect(await harness.service.listSessions('owner-b', { projectId: PROJECT_ID })).toMatchObject([
      { executable: 'sh', arguments: [] },
    ]);
    await expect(harness.service.getSession('owner-b', { sessionId: SESSION_ID })).rejects.toThrow(
      /another Forgeboard window/u,
    );
    await expect(harness.service.replay('owner-b', { sessionId: SESSION_ID })).rejects.toThrow(
      /another Forgeboard window/u,
    );
    await expect(
      harness.service.sendInput('owner-b', {
        sessionId: SESSION_ID,
        data: 'hidden',
      }),
    ).rejects.toThrow(/another Forgeboard window/u);

    harness.pty.emitData('ready\0now\r\n');
    await expectEventually(async () => {
      const replay = await harness.service.replay('owner-a', {
        sessionId: SESSION_ID,
      });
      return replay?.chunks[0]?.data === 'ready\uFFFDnow\r\n';
    });
    expect(events.every((event) => event.ownerId === 'owner-a')).toBe(true);
    expect(JSON.stringify(events.map((event) => event.event))).not.toContain('ownerId');

    await harness.service.sendInput('owner-a', {
      sessionId: SESSION_ID,
      data: 'echo safe\r',
    });
    await harness.service.resize('owner-a', {
      sessionId: SESSION_ID,
      columns: 132,
      rows: 47,
    });
    await harness.service.interrupt('owner-a', { sessionId: SESSION_ID });
    expect(harness.pty.writes).toEqual(['echo safe\r']);
    expect(harness.pty.interrupts).toBe(1);
    expect(harness.pty.resizes).toEqual([{ columns: 132, rows: 47 }]);

    harness.pty.emitExit({ exitCode: 130, signal: null });
    await expectEventually(
      async () =>
        (await harness.service.getSession('owner-a', { sessionId: SESSION_ID }))?.status ===
        'interrupted',
    );
  });

  it('rechecks expiry and async launch authority immediately before spawn', async () => {
    let now = new Date('2026-07-17T16:00:00.000Z');
    const expired = await fixture({ now: () => now, planTtlMs: 10 });
    const plan = await expired.service.prepareLaunch('owner-a', expired.input);
    await expect(
      expired.service.confirmLaunch('owner-a', plan.planId, () => {
        now = new Date('2026-07-17T16:00:00.011Z');
        return Promise.resolve('approved');
      }),
    ).rejects.toThrow(/expired/u);
    expect(expired.spawned()).toBe(false);

    const changed = await fixture();
    const changedPlan = await changed.service.prepareLaunch('owner-a', changed.input);
    await expect(
      changed.service.confirmLaunch('owner-a', changedPlan.planId, async () => {
        await mkdir(path.join(changed.project.path, 'changed-after-review'));
        return 'approved';
      }),
    ).rejects.toThrow(/changed after review/u);
    expect(changed.spawned()).toBe(false);
  });

  it('fails closed before PTY creation when the required launch audit cannot persist', async () => {
    const harness = await fixture();
    harness.store.failLaunchAudit = true;
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);

    await expect(
      harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('required terminal launch audit unavailable');
    expect(harness.spawned()).toBe(false);
    expect(harness.store.sessions.get(SESSION_ID)?.session.status).toBe('failed');
  });

  it('keeps an expired transcript and session when its required retention audit fails', async () => {
    const harness = await fixture({ expiredSession: true, failRetentionAudit: true });
    const transcript = path.join(harness.transcriptRoot, `${SESSION_ID}.jsonl`);

    await expect(harness.service.assertProjectAvailable(PROJECT_ID)).rejects.toThrow(
      'required terminal retention audit unavailable',
    );
    await expect(access(transcript)).resolves.toBeUndefined();
    expect(harness.store.sessions.has(SESSION_ID)).toBe(true);
  });

  it('keeps an orphaned transcript when its required retention audit fails', async () => {
    const harness = await fixture({ orphanedTranscript: true, failRetentionAudit: true });
    const transcript = path.join(harness.transcriptRoot, `${SESSION_ID}.jsonl`);

    await expect(harness.service.assertProjectAvailable(PROJECT_ID)).rejects.toThrow(
      'required terminal retention audit unavailable',
    );
    await expect(access(transcript)).resolves.toBeUndefined();
    expect(harness.store.sessions.has(SESSION_ID)).toBe(false);
  });

  it('records a redacted failed outcome when an expired session row cannot be deleted', async () => {
    const harness = await fixture({ expiredSession: true, failSessionDeletion: true });
    const transcript = path.join(harness.transcriptRoot, `${SESSION_ID}.jsonl`);

    await expect(harness.service.assertProjectAvailable(PROJECT_ID)).rejects.toThrow(
      'simulated terminal session deletion failure',
    );
    await expect(access(transcript)).rejects.toThrow();
    expect(harness.store.sessions.has(SESSION_ID)).toBe(true);
    expect(harness.store.audits).toContainEqual([
      'terminal',
      'retention-delete',
      'failed',
      {
        sessionId: SESSION_ID,
        reason: 'expired-session',
        stage: 'session-record',
        errorKind: 'Error',
        effectSemantics: 'best-effort-nontransactional',
      },
    ]);
  });

  it('refuses merge pause without killing work, then drains privacy and shutdown explicitly', async () => {
    const harness = await fixture();
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);
    await harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved'));

    await expect(harness.service.pauseForDataMutation()).rejects.toThrow(/Stop every terminal/u);
    await expect(
      harness.service.sendInput('owner-a', {
        sessionId: SESSION_ID,
        data: 'still-here',
      }),
    ).resolves.toMatchObject({ status: 'running' });

    await harness.service.resetForPrivacy();
    expect(harness.pty.terminations).toBe(1);
    expect(harness.store.sessions.size).toBe(0);

    const shutdown = await fixture();
    const shutdownPlan = await shutdown.service.prepareLaunch('owner-a', shutdown.input);
    await shutdown.service.confirmLaunch('owner-a', shutdownPlan.planId, () =>
      Promise.resolve('approved'),
    );
    await shutdown.service.pauseForShutdown();
    expect(shutdown.store.sessions.get(SESSION_ID)?.session.status).toBe('lost');
  });

  it('normalizes NUL and splits UTF-8 output without exceeding the contract byte bound', () => {
    const chunks = splitTerminalOutput(`${'🧪'.repeat(20_000)}\0tail`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 64 * 1_024)).toBe(true);
    expect(chunks.join('')).toContain('\uFFFDtail');
    expect(chunks.join('')).not.toContain('\0');
  });

  it('keeps the PTY bounded and reports lost when transcript/session persistence fails', async () => {
    const harness = await fixture();
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);
    await harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved'));
    harness.store.failUpdates = true;

    harness.pty.emitData('output-that-cannot-be-checkpointed');
    await expectEventually(async () =>
      Boolean(
        (await harness.service.getSession('owner-a', { sessionId: SESSION_ID }))?.outputTruncated,
      ),
    );
    harness.pty.emitExit({ exitCode: 0, signal: null });
    await expectEventually(
      async () =>
        (await harness.service.getSession('owner-a', { sessionId: SESSION_ID }))?.status === 'lost',
    );
    expect(JSON.stringify(harness.store.audits)).not.toContain(
      'output-that-cannot-be-checkpointed',
    );
  });

  it('kills a spawned PTY and settles it lost when the running checkpoint fails', async () => {
    const harness = await fixture({ failAfterSpawn: true });
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);

    await expect(
      harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow(/simulated terminal metadata write failure/u);
    expect(harness.pty.terminations).toBe(1);
    expect(harness.store.sessions.get(SESSION_ID)?.session.status).toBe('lost');
    await expect(
      harness.service.sendInput('owner-a', {
        sessionId: SESSION_ID,
        data: 'must-not-run',
      }),
    ).rejects.toThrow(/no longer active/u);
  });

  it('reports an unconfirmed terminate timeout as lost after both stop attempts', async () => {
    const harness = await fixture();
    harness.pty.exitOnTerminate = false;
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);
    await harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved'));

    await expect(
      harness.service.terminate('owner-a', { sessionId: SESSION_ID }),
    ).resolves.toMatchObject({
      status: 'lost',
      exitSignal: 'FORGEBOARD_STOP_UNCONFIRMED',
    });
    expect(harness.pty.terminations).toBe(1);
    expect(harness.pty.forceTerminations).toBe(1);
  });

  it('does not classify a later successful exit as interrupted after continued input', async () => {
    const harness = await fixture();
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);
    await harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved'));

    await harness.service.interrupt('owner-a', { sessionId: SESSION_ID });
    await harness.service.sendInput('owner-a', {
      sessionId: SESSION_ID,
      data: 'exit\r',
    });
    harness.pty.emitExit({ exitCode: 0, signal: null });

    await expectEventually(
      async () =>
        (await harness.service.getSession('owner-a', { sessionId: SESSION_ID }))?.status ===
        'exited',
    );
  });

  it('discloses a missing durable transcript instead of returning false complete history', async () => {
    const harness = await fixture();
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);
    await harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved'));
    harness.pty.emitData('durable output');
    await expectEventually(async () => {
      const replay = await harness.service.replay('owner-a', {
        sessionId: SESSION_ID,
      });
      return replay?.chunks[0]?.data === 'durable output';
    });
    await rm(path.join(harness.transcriptRoot, `${SESSION_ID}.jsonl`));

    await expect(
      harness.service.replay('owner-a', { sessionId: SESSION_ID }),
    ).resolves.toMatchObject({
      session: { outputTruncated: true },
      chunks: [],
      hasMore: false,
    });
    expect(harness.store.sessions.get(SESSION_ID)?.session.outputTruncated).toBe(true);
  });

  it('bounds and coalesces flood output while keeping the PTY controllable', async () => {
    const harness = await fixture();
    const events: TerminalEvent[] = [];
    harness.service.subscribe((_ownerId, event) => events.push(event));
    const plan = await harness.service.prepareLaunch('owner-a', harness.input);
    await harness.service.confirmLaunch('owner-a', plan.planId, () => Promise.resolve('approved'));

    harness.pty.emitData('x'.repeat(3 * 1_024 * 1_024));
    harness.pty.emitData('must-be-dropped-after-overflow');
    await expect(
      harness.service.sendInput('owner-a', {
        sessionId: SESSION_ID,
        data: 'still-responsive\r',
      }),
    ).resolves.toMatchObject({ outputTruncated: true });
    await expect(
      harness.service.terminate('owner-a', { sessionId: SESSION_ID }),
    ).resolves.toMatchObject({ status: 'terminated', outputTruncated: true });

    const output = events.filter(
      (event): event is Extract<TerminalEvent, { kind: 'output' }> => event.kind === 'output',
    );
    expect(output).toHaveLength(16);
    expect(output.reduce((bytes, event) => bytes + Buffer.byteLength(event.chunk.data), 0)).toBe(
      1_024 * 1_024,
    );
    expect(output.some((event) => event.chunk.data.includes('must-be-dropped'))).toBe(false);
    expect(harness.pty.writes).toEqual(['still-responsive\r']);
  });

  it('preserves startup rejection for callers without creating an unhandled promise', async () => {
    const projectRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'forgeboard-terminal-invalid-root-')),
    );
    const invalidRoot = path.join(projectRoot, 'not-a-directory');
    await writeFile(invalidRoot, 'ordinary file', { mode: 0o600 });
    const project = {
      id: PROJECT_ID,
      name: 'Invalid transcript root fixture',
      path: projectRoot,
      missing: false,
    } as Project;
    const service = new TerminalService(new FakeTerminalStore(project), invalidRoot, () =>
      settings(),
    );
    services.push(service);

    await expect(service.assertProjectAvailable(PROJECT_ID)).rejects.toThrow(
      /file already exists|canonical ordinary directory/u,
    );
  });

  describe('agent peer hooks', () => {
    it('finds the running session for a project/node pair and forgets it once inactive', async () => {
      const harness = await fixture();
      const plan = await harness.service.prepareLaunch('owner-a', harness.input);
      await harness.service.confirmLaunch('owner-a', plan.planId, () =>
        Promise.resolve('approved'),
      );

      expect(harness.service.findActiveSessionByNode(PROJECT_ID, 'terminal-1')).toEqual({
        sessionId: SESSION_ID,
      });
      expect(harness.service.findActiveSessionByNode(PROJECT_ID, 'wrong-node')).toBeNull();
      expect(harness.service.findActiveSessionByNode('wrong-project', 'terminal-1')).toBeNull();

      await harness.service.terminate('owner-a', { sessionId: SESSION_ID });
      expect(harness.service.findActiveSessionByNode(PROJECT_ID, 'terminal-1')).toBeNull();
    });

    it('delivers a peer message as a bracketed-paste write and audits it as agent-peer input', async () => {
      const harness = await fixture();
      const plan = await harness.service.prepareLaunch('owner-a', harness.input);
      await harness.service.confirmLaunch('owner-a', plan.planId, () =>
        Promise.resolve('approved'),
      );

      await expect(harness.service.deliverPeerInput(SESSION_ID, 'Hermes', 'hi')).resolves.toBe(
        'delivered',
      );
      expect(harness.pty.writes).toEqual([formatPeerDelivery('Hermes', 'hi')]);
      expect(harness.store.audits).toContainEqual([
        'terminal',
        'input',
        'allowed',
        expect.objectContaining({
          sessionId: SESSION_ID,
          source: 'agent-peer',
          sender: 'Hermes',
        }),
      ]);
    });

    it('reports no-live-session for an unknown or inactive session and writes nothing', async () => {
      const harness = await fixture();

      await expect(
        harness.service.deliverPeerInput(UNKNOWN_SESSION_ID, 'Hermes', 'hi'),
      ).resolves.toBe('no-live-session');
      expect(harness.pty.writes).toEqual([]);
    });

    it('reads a stripped transcript tail and returns null for an unknown session', async () => {
      const harness = await fixture();
      const plan = await harness.service.prepareLaunch('owner-a', harness.input);
      await harness.service.confirmLaunch('owner-a', plan.planId, () =>
        Promise.resolve('approved'),
      );
      harness.pty.emitData('hello \x1b[31mworld\x1b[0m\r\n');
      await expectEventually(async () => {
        const replay = await harness.service.replay('owner-a', { sessionId: SESSION_ID });
        return replay?.chunks[0]?.data === 'hello \x1b[31mworld\x1b[0m\r\n';
      });

      await expect(harness.service.readTranscriptTail(SESSION_ID, 1_024)).resolves.toBe(
        'hello world',
      );
      await expect(
        harness.service.readTranscriptTail(UNKNOWN_SESSION_ID, 1_024),
      ).resolves.toBeNull();
    });
  });

  async function fixture(
    options: {
      readonly now?: () => Date;
      readonly planTtlMs?: number;
      readonly failAfterSpawn?: boolean;
      readonly expiredSession?: boolean;
      readonly orphanedTranscript?: boolean;
      readonly failRetentionAudit?: boolean;
      readonly failSessionDeletion?: boolean;
    } = {},
  ): Promise<{
    readonly service: TerminalService;
    readonly store: FakeTerminalStore;
    readonly pty: FakePty;
    readonly input: TerminalPrepareLaunchInput;
    readonly project: Project;
    readonly transcriptRoot: string;
    readonly spawned: () => boolean;
  }> {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'forgeboard-terminal-service-')),
    );
    const transcriptRoot = path.join(root, 'private-transcripts');
    const project = {
      id: PROJECT_ID,
      name: 'Terminal fixture',
      path: root,
      missing: false,
    } as Project;
    const store = new FakeTerminalStore(project);
    store.failRetentionAudit = options.failRetentionAudit === true;
    store.failSessionDeletion = options.failSessionDeletion === true;
    if (options.expiredSession === true) {
      store.sessions.set(SESSION_ID, terminalStorageRecord(expiredTerminalSession()));
      store.expiredSessionIds.push(SESSION_ID);
    }
    if (options.expiredSession === true || options.orphanedTranscript === true) {
      await mkdir(transcriptRoot, { recursive: true, mode: 0o700 });
      await writeFile(path.join(transcriptRoot, `${SESSION_ID}.jsonl`), '', { mode: 0o600 });
    }
    const pty = new FakePty();
    let didSpawn = false;
    const ids = [PLAN_ID, SESSION_ID];
    const service = new TerminalService(store, transcriptRoot, () => settings(), {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
      createId: () => ids.shift() ?? '40000000-0000-4000-8000-000000000001',
      ptyFactory: async (_launch, beforeSpawn) => {
        await beforeSpawn();
        didSpawn = true;
        if (options.failAfterSpawn === true) store.failUpdateCount = 1;
        return pty;
      },
      terminateGraceMs: 20,
      forceTerminateMs: 20,
      maximumTranscriptBytes: 1_024 * 1_024,
      maximumTotalTranscriptBytes: 2 * 1_024 * 1_024,
      maximumTranscriptFiles: 10,
    });
    services.push(service);
    return {
      service,
      store,
      pty,
      project,
      transcriptRoot,
      spawned: () => didSpawn,
      input: {
        projectId: PROJECT_ID,
        nodeId: 'terminal-1',
        executable: '/bin/sh',
        arguments: ['-l'],
        cwdRelative: '.',
        environmentVariableNames: ['PATH'],
        columns: 100,
        rows: 30,
      },
    };
  }
});

class FakeTerminalStore implements TerminalServiceStore {
  readonly sessions = new Map<string, StoredTerminalSession>();
  readonly audits: unknown[] = [];
  failUpdates = false;
  failUpdateCount = 0;
  failLaunchAudit = false;
  failRetentionAudit = false;
  failSessionDeletion = false;
  readonly expiredSessionIds: string[] = [];

  public constructor(private readonly project: Project) {}

  getProject(projectId: string): Project | undefined {
    return projectId === this.project.id ? this.project : undefined;
  }

  createTerminalSession(session: TerminalSessionView): void {
    this.sessions.set(session.id, terminalStorageRecord(session));
  }

  updateTerminalSession(
    session: TerminalSessionView,
    transcript?: {
      readonly transcriptBytes: number;
      readonly lastPersistedSequence: number;
    },
  ): void {
    if (this.failUpdates || this.failUpdateCount > 0) {
      this.failUpdateCount = Math.max(0, this.failUpdateCount - 1);
      throw new Error('simulated terminal metadata write failure');
    }
    const current = this.sessions.get(session.id);
    if (current === undefined) throw new Error('missing fake terminal session');
    this.sessions.set(session.id, terminalStorageRecord(session, transcript ?? current));
  }

  getTerminalSession(sessionId: string): TerminalSessionView | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  getTerminalSessionRecord(sessionId: string): StoredTerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  listTerminalSessions(projectId: string, nodeId?: string): TerminalSessionView[] {
    return [...this.sessions.values()]
      .map((record) => record.session)
      .filter(
        (session) =>
          session.projectId === projectId && (nodeId === undefined || session.nodeId === nodeId),
      );
  }

  recoverInterruptedTerminalSessions(now = new Date()) {
    return { lostSessionIds: [], recoveredAt: now.toISOString() };
  }

  deleteTerminalSession(sessionId: string): boolean {
    if (this.failSessionDeletion) throw new Error('simulated terminal session deletion failure');
    return this.sessions.delete(sessionId);
  }

  deleteTerminalSessions(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  listAllTerminalSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  listExpiredTerminalSessionIds(): string[] {
    return [...this.expiredSessionIds];
  }

  appendAudit(...value: unknown[]): void {
    if (this.failLaunchAudit && value[1] === 'launch' && value[2] === 'allowed') {
      throw new Error('required terminal launch audit unavailable');
    }
    if (this.failRetentionAudit && value[1] === 'retention-delete' && value[2] === 'allowed') {
      throw new Error('required terminal retention audit unavailable');
    }
    this.audits.push(value);
  }
}

function expiredTerminalSession(): TerminalSessionView {
  const endedAt = '2026-06-01T12:00:00.000Z';
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    nodeId: 'terminal-1',
    executable: '/bin/sh',
    arguments: ['-l'],
    cwdRelative: '.',
    environmentVariableNames: ['PATH'],
    columns: 100,
    rows: 30,
    permission: {
      label: 'Local process',
      sandboxed: false,
      filesystem: 'operating-system-user',
      network: 'operating-system-user',
      detail: 'The working directory limits context but is not a security sandbox.',
    },
    status: 'exited',
    startedAt: endedAt,
    endedAt,
    exitCode: 0,
    exitSignal: null,
    earliestSequence: 1,
    nextSequence: 1,
    outputTruncated: false,
    updatedAt: endedAt,
  };
}

class FakePty implements TerminalPtyHandle {
  readonly pid = 42;
  readonly writes: string[] = [];
  readonly resizes: { columns: number; rows: number }[] = [];
  interrupts = 0;
  terminations = 0;
  forceTerminations = 0;
  exitOnTerminate = true;
  #data: ((data: string) => void) | null = null;
  #exit: ((exit: TerminalPtyExit) => void) | null = null;

  onData(listener: (data: string) => void): () => void {
    this.#data = listener;
    return () => {
      if (this.#data === listener) this.#data = null;
    };
  }

  onExit(listener: (exit: TerminalPtyExit) => void): () => void {
    this.#exit = listener;
    return () => {
      if (this.#exit === listener) this.#exit = null;
    };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows });
  }

  interrupt(): void {
    this.interrupts += 1;
  }

  terminate(): void {
    this.terminations += 1;
    if (this.exitOnTerminate) this.emitExit({ exitCode: 143, signal: 'SIGTERM' });
  }

  forceTerminate(): void {
    this.forceTerminations += 1;
    if (this.exitOnTerminate) this.emitExit({ exitCode: 137, signal: 'SIGKILL' });
  }

  emitData(data: string): void {
    this.#data?.(data);
  }

  emitExit(exit: TerminalPtyExit): void {
    const listener = this.#exit;
    this.#exit = null;
    listener?.(exit);
  }
}

function settings(): AppSettings {
  return {
    envAllowlist: ['PATH'],
    transcriptRetentionDays: 30,
  } as AppSettings;
}

async function expectEventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('Timed out waiting for terminal state.');
}
