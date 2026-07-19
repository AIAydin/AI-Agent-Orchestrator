import type { Dialog, IpcMainInvokeEvent, MessageBoxOptions, WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getBuiltInAgentManifest } from '@forgeboard/agent-adapters';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    fromWebContents: vi.fn(),
    handle: vi.fn((channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => electronMock.handlers.delete(channel)),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
}));

import { IPC_CHANNELS } from '../../shared/application/contracts.js';
import type { AgentReadinessResult } from '../../shared/readiness/contracts.js';
import { AgentReadinessIpcService, type AgentReadinessOperations } from './ipc.js';
import type { AgentReadinessProbePlan } from './service.js';

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
  electronMock.fromWebContents.mockReset();
});

describe('AgentReadinessIpcService', () => {
  it('returns passive missing evidence without opening a native dialog', async () => {
    const fixture = createFixture({ preparation: { outcome: 'result', result: failedResult() } });
    fixture.service.registerIpcHandler();

    await expect(requiredHandler()(liveEvent(), { agentId: 'codex' })).resolves.toEqual({
      ok: true,
      value: failedResult(),
    });
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.probe).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('keeps native cancellation honest and starts no readiness subprocess', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 0 });
    fixture.service.registerIpcHandler();

    await expect(requiredHandler()(liveEvent(), { agentId: 'codex' })).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({
        buttons: ['Cancel', 'Run readiness probes'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.showMessageBox.mock.calls[0]?.[1].detail).toContain(
      `SHA-256: ${PLAN.executableIdentity.sha256}`,
    );
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'agent',
      'readiness-check',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    await fixture.service.dispose();
  });

  it('revalidates the exact live owner immediately before every approved probe', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1, invokeAuthorization: true });
    fixture.service.registerIpcHandler();

    await expect(requiredHandler()(liveEvent(), { agentId: 'codex' })).resolves.toEqual({
      ok: true,
      value: readyResult(),
    });
    expect(fixture.authorizations).toBe(2);
    expect(fixture.probe).toHaveBeenCalledWith(PLAN, expect.any(Function));
    expect(fixture.appendAudit).toHaveBeenNthCalledWith(
      1,
      'agent',
      'readiness-probe',
      'allowed',
      expect.objectContaining({
        executableSha256: PLAN.executableIdentity.sha256,
        probeSequence: 1,
        probeKind: 'version',
        phase: 'authorized-before-spawn',
      }),
    );
    expect(fixture.appendAudit).toHaveBeenNthCalledWith(
      2,
      'agent',
      'readiness-probe',
      'allowed',
      expect.objectContaining({ probeSequence: 2, probeKind: 'capability' }),
    );
    expect(fixture.recordVerifiedSettingsReadiness).toHaveBeenCalledWith(PLAN, readyResult());
    await fixture.service.dispose();
  });

  it('admits no Settings evidence when the owner changes while a probe is running', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const completed = deferred<AgentReadinessResult>();
    const fixture = createFixture({ nativeResponse: 1 });
    fixture.probe.mockImplementationOnce(async () => await completed.promise);
    fixture.service.registerIpcHandler();
    const event = liveEvent();
    const request = requiredHandler()(event, { agentId: 'codex' });
    await vi.waitFor(() => expect(fixture.probe).toHaveBeenCalledTimes(1));
    Object.defineProperty(event, 'senderFrame', { value: {} });
    completed.resolve(readyResult());

    await expect(request).resolves.toMatchObject({ ok: false });
    expect(fixture.recordVerifiedSettingsReadiness).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('admits no Settings evidence when the readiness audit cannot be recorded', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1 });
    fixture.appendAudit.mockImplementation(() => {
      throw new Error('audit unavailable');
    });
    fixture.service.registerIpcHandler();

    await expect(requiredHandler()(liveEvent(), { agentId: 'codex' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.recordVerifiedSettingsReadiness).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('rejects subframes before passive discovery or native confirmation', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandler();
    const event = liveEvent();
    Object.defineProperty(event, 'senderFrame', { value: {} });

    await expect(requiredHandler()(event, { agentId: 'codex' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('rejects passive readiness evidence when the owner changes during discovery', async () => {
    const preparation = deferred<Awaited<ReturnType<AgentReadinessOperations['prepare']>>>();
    const fixture = createFixture();
    fixture.prepare.mockImplementationOnce(async () => await preparation.promise);
    fixture.service.registerIpcHandler();
    const event = liveEvent();
    const request = requiredHandler()(event, { agentId: 'codex' });
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
    Object.defineProperty(event, 'senderFrame', { value: {} });
    preparation.resolve({ outcome: 'result', result: failedResult() });

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.appendAudit).not.toHaveBeenCalledWith(
      'agent',
      'readiness-check',
      'denied',
      expect.objectContaining({ state: failedResult().state }),
    );
    await fixture.service.dispose();
  });

  it('fails closed when the exact parent is replaced during confirmation', async () => {
    const parent = { isDestroyed: () => false };
    const replacement = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValueOnce(parent).mockReturnValue(replacement);
    const fixture = createFixture({ nativeResponse: 1 });
    fixture.service.registerIpcHandler();

    await expect(requiredHandler()(liveEvent(), { agentId: 'codex' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.probe).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('does not probe an approval plan that expires while the native dialog is open', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({
      nativeResponse: 1,
      now: () => new Date(PLAN.expiresAtMs),
    });
    fixture.service.registerIpcHandler();

    await expect(requiredHandler()(liveEvent(), { agentId: 'codex' })).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'agent',
      'readiness-check',
      'denied',
      expect.objectContaining({ reason: 'readiness-plan-expired' }),
    );
    await fixture.service.dispose();
  });

  it('drains an admitted dialog and blocks its probe when shutdown begins', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const decision = deferred<{ response: number; checkboxChecked: boolean }>();
    const fixture = createFixture({ decision: decision.promise });
    fixture.service.registerIpcHandler();
    const request = requiredHandler()(liveEvent(), { agentId: 'codex' });
    await vi.waitFor(() => expect(fixture.showMessageBox).toHaveBeenCalledTimes(1));

    const paused = fixture.service.pauseForShutdown();
    let drained = false;
    void paused.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    decision.resolve({ response: 1, checkboxChecked: false });

    await expect(request).resolves.toMatchObject({ ok: false });
    await paused;
    expect(fixture.probe).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });
});

function createFixture(
  options: {
    readonly nativeResponse?: number;
    readonly invokeAuthorization?: boolean;
    readonly decision?: Promise<{ response: number; checkboxChecked: boolean }>;
    readonly preparation?: Awaited<ReturnType<AgentReadinessOperations['prepare']>>;
    readonly now?: () => Date;
  } = {},
) {
  const prepare = vi.fn(() =>
    Promise.resolve(options.preparation ?? { outcome: 'probe' as const, plan: PLAN }),
  );
  let authorizations = 0;
  const probe = vi.fn(
    (
      _plan: AgentReadinessProbePlan,
      authorize: (attempt: {
        readonly sequence: number;
        readonly kind: 'version' | 'capability';
        readonly argumentCount: number;
      }) => void,
    ) => {
      if (options.invokeAuthorization === true) {
        authorize({ sequence: 1, kind: 'version', argumentCount: 1 });
        authorizations += 1;
        authorize({ sequence: 2, kind: 'capability', argumentCount: 1 });
        authorizations += 1;
      }
      return Promise.resolve(readyResult());
    },
  );
  const showMessageBox = vi.fn((...dialogArguments: [unknown, MessageBoxOptions]) => {
    void dialogArguments;
    return options.decision === undefined
      ? Promise.resolve({
          response: options.nativeResponse ?? 0,
          checkboxChecked: false,
        })
      : options.decision;
  });
  const appendAudit = vi.fn();
  const recordVerifiedSettingsReadiness = vi.fn();
  const service = new AgentReadinessIpcService(
    {
      showMessageBox: showMessageBox as unknown as Pick<Dialog, 'showMessageBox'>['showMessageBox'],
    },
    { prepare, probe, recordVerifiedSettingsReadiness },
    { appendAudit },
    undefined,
    options.now ?? (() => new Date('2026-07-15T12:00:00.000Z')),
  );
  return {
    service,
    prepare,
    probe,
    recordVerifiedSettingsReadiness,
    showMessageBox,
    appendAudit,
    get authorizations() {
      return authorizations;
    },
  };
}

const PLAN: AgentReadinessProbePlan = {
  request: { agentId: 'codex' },
  source: 'automatic',
  manifest: getBuiltInAgentManifest('codex')!,
  executable: '/canonical/bin/codex',
  executableIdentity: {
    device: 1,
    inode: 2,
    size: 3,
    modifiedAtMs: 4,
    sha256: 'a'.repeat(64),
  },
  versionArguments: ['--version'],
  capabilityArguments: ['--help'],
  providerName: 'OpenAI',
  providerDisclosure: 'The selected CLI may send context to its configured provider.',
  expiresAtMs: Date.parse('2026-07-15T12:05:00.000Z'),
};

function readyResult(): AgentReadinessResult {
  return {
    schemaVersion: 1,
    agentId: 'codex',
    state: 'ready',
    ready: true,
    source: 'automatic',
    executable: PLAN.executable,
    version: '1.2.3',
    checkedAt: '2026-07-15T12:00:00.000Z',
    reason: null,
    warnings: [],
  };
}

function failedResult(): AgentReadinessResult {
  return {
    schemaVersion: 1,
    agentId: 'codex',
    state: 'executable-missing',
    ready: false,
    source: 'automatic',
    executable: null,
    version: null,
    checkedAt: '2026-07-15T12:00:00.000Z',
    reason: 'Executable was not found.',
    warnings: [],
  };
}

function liveEvent(): IpcMainInvokeEvent {
  const mainFrame = {};
  const sender = {
    id: 42,
    mainFrame,
    isDestroyed: () => false,
  } as unknown as WebContents;
  return { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

function requiredHandler() {
  const handler = electronMock.handlers.get(IPC_CHANNELS.agentsCheckReadiness);
  if (handler === undefined) throw new Error('Missing agent readiness IPC handler.');
  return handler;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
