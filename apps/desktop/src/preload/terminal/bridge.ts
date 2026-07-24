import type { z } from 'zod';

import type { ForgeboardApi } from '../../shared/api.js';
import { ipcResultSchema, type IpcResult } from '../../shared/application/contracts.js';
import {
  TERMINAL_IPC_CHANNELS,
  TerminalChooseExecutableInputSchema,
  TerminalEventSchema,
  TerminalExecutableSelectionViewSchema,
  TerminalInputSchema,
  TerminalLaunchPlanCancelResultSchema,
  TerminalLaunchPlanConfirmationInputSchema,
  TerminalLaunchPlanViewSchema,
  TerminalPrepareLaunchInputSchema,
  TerminalReplayInputSchema,
  TerminalReplayViewSchema,
  TerminalResizeInputSchema,
  TerminalSessionListInputSchema,
  TerminalSessionListViewSchema,
  TerminalSessionTargetInputSchema,
  TerminalSessionViewSchema,
  type TerminalEvent,
  type TerminalPrepareLaunchInput,
  type TerminalSessionListInput,
} from '../../shared/terminal/index.js';

export type TerminalIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;
export type TerminalIpcSubscriber = (
  channel: string,
  listener: (payload: unknown) => void,
) => () => void;

/** Creates a strict, owner-opaque bridge for user-controlled PTY sessions. */
export function createTerminalApi(
  invoke: TerminalIpcInvoker,
  subscribe: TerminalIpcSubscriber,
): ForgeboardApi['terminal'] {
  return {
    chooseExecutable: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.chooseExecutable,
        TerminalChooseExecutableInputSchema,
        TerminalExecutableSelectionViewSchema.nullable(),
        input,
      ),
    prepareLaunch: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.prepareLaunch,
        TerminalPrepareLaunchInputSchema,
        launchPlanFor(input),
        input,
      ),
    cancelLaunch: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.cancelLaunch,
        TerminalLaunchPlanConfirmationInputSchema,
        TerminalLaunchPlanCancelResultSchema.refine((result) => result.planId === input.planId, {
          message: 'The cancelled plan does not match the requested terminal plan.',
        }),
        input,
      ),
    confirmLaunch: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.confirmLaunch,
        TerminalLaunchPlanConfirmationInputSchema,
        TerminalSessionViewSchema.nullable(),
        input,
      ),
    getSession: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.getSession,
        TerminalSessionTargetInputSchema,
        sessionFor(input.sessionId).nullable(),
        input,
      ),
    listSessions: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.listSessions,
        TerminalSessionListInputSchema,
        sessionListFor(input),
        input,
      ),
    replay: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.replay,
        TerminalReplayInputSchema,
        TerminalReplayViewSchema.refine((replay) => replay.session.id === input.sessionId, {
          message: 'The replay does not match the requested terminal session.',
        }).nullable(),
        input,
      ),
    sendInput: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.sendInput,
        TerminalInputSchema,
        sessionFor(input.sessionId),
        input,
      ),
    resize: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.resize,
        TerminalResizeInputSchema,
        sessionFor(input.sessionId),
        input,
      ),
    interrupt: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.interrupt,
        TerminalSessionTargetInputSchema,
        sessionFor(input.sessionId),
        input,
      ),
    terminate: async (input) =>
      await invokeTerminal(
        invoke,
        TERMINAL_IPC_CHANNELS.terminate,
        TerminalSessionTargetInputSchema,
        sessionFor(input.sessionId),
        input,
      ),
    onEvent: (listener) =>
      subscribe(TERMINAL_IPC_CHANNELS.event, (payload) => {
        const event = TerminalEventSchema.safeParse(payload);
        if (event.success) listener(event.data);
      }),
  };
}

function launchPlanFor(input: TerminalPrepareLaunchInput) {
  return TerminalLaunchPlanViewSchema.superRefine((plan, context) => {
    const mismatched =
      plan.projectId !== input.projectId ||
      plan.nodeId !== input.nodeId ||
      plan.executable !== input.executable ||
      plan.cwdRelative !== input.cwdRelative ||
      plan.columns !== input.columns ||
      plan.rows !== input.rows ||
      JSON.stringify(plan.workspace ?? { kind: 'project' }) !==
        JSON.stringify(input.workspace ?? { kind: 'project' }) ||
      !sameStrings(plan.arguments, input.arguments) ||
      !sameStrings(plan.environmentVariableNames, input.environmentVariableNames);
    if (mismatched) {
      context.addIssue({
        code: 'custom',
        message: 'The terminal launch plan does not match the requested literal configuration.',
      });
    }
  });
}

function sessionFor(sessionId: string) {
  return TerminalSessionViewSchema.refine((session) => session.id === sessionId, {
    message: 'The response does not match the requested terminal session.',
  });
}

function sessionListFor(input: TerminalSessionListInput) {
  return TerminalSessionListViewSchema.superRefine((sessions, context) => {
    if (
      sessions.some(
        (session) =>
          session.projectId !== input.projectId ||
          (input.nodeId !== undefined && session.nodeId !== input.nodeId),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The response contains a terminal session outside the requested scope.',
      });
    }
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function invokeTerminal<Input, Output>(
  invoke: TerminalIpcInvoker,
  channel: string,
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: Input,
): Promise<IpcResult<Output>> {
  const parsedInput = inputSchema.parse(input);
  const rawResult: unknown = await invoke(channel, parsedInput);
  return ipcResultSchema(outputSchema).parse(rawResult);
}

export type TerminalBridgeEvent = TerminalEvent;
