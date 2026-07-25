import type {
  AppSettings,
  CommandConfiguration,
} from '../../../../../shared/application/contracts.js';
import { CheckIdSchema, type CheckKind } from '../../../../../shared/checks/contracts.js';
import type { WorkflowReviewGateView } from '../../../../../shared/workflow/contracts.js';
import type { NodeKind, WorkshopCommandConfiguration, WorkshopNode } from '../canvas/CanvasNode.js';
import { permissionProfileUnavailableReason } from '../../permissions/permission-profile-ui.js';

const BUILT_IN_CHECK_KINDS = new Set<CheckKind>(['lint', 'typecheck', 'test', 'build']);

export function initialWorkflowNodeData(
  kind: NodeKind,
  _nodeId: string,
  settings: AppSettings,
): Partial<WorkshopNode['data']> {
  if (kind === 'agent') {
    const adapterId = settings.defaultAgent;
    const permissionProfile =
      permissionProfileUnavailableReason(settings.defaultPermissionProfile, settings) !== null
        ? 'worktree-write'
        : settings.defaultPermissionProfile;
    return { adapterId, permissionProfile };
  }
  if (kind === 'terminal') {
    return {
      command: {
        executable: settings.terminalShell,
        arguments: [],
        cwdRelative: '.',
        environmentNames: [...settings.envAllowlist],
      },
    };
  }
  if (kind === 'test') {
    return {
      command: copyCommand(settings.testCommand),
      checkKind: 'test',
      runIds: ['test'],
    };
  }
  if (kind === 'review-gate') {
    return {
      humanApprovalRequired: true,
      requiredCheckIds: [],
      lintRequired: false,
      testsRequired: false,
      retryPolicy: { maximumIterations: 3, backoffMs: 0 },
    };
  }
  if (kind === 'diff') {
    return {
      reviewTarget: { kind: 'primary' },
      viewMode: 'split',
      showWhitespace: false,
      approval: 'pending',
    };
  }
  return {};
}

export function checkProducerId(node: WorkshopNode): string {
  return checkProducerIdFor(node.data, node.id);
}

/** Data-based variant of {@link checkProducerId} for callers holding only `data` + `id` (faces). */
export function checkProducerIdFor(data: WorkshopNode['data'], nodeId: string): string {
  const kind = data.checkKind ?? 'test';
  if (kind !== 'custom') return kind;
  const configured = data.runIds?.[0];
  return isCustomCheckId(configured) ? configured : nodeId;
}

export function normalizeCheckProducerData(data: WorkshopNode['data']): WorkshopNode['data'] {
  if (data.kind !== 'test') return data;
  const kind = data.checkKind ?? 'test';
  if (kind === 'custom' || (data.runIds?.length === 1 && data.runIds[0] === kind)) return data;
  return { ...data, checkKind: kind, runIds: [kind] };
}

export function normalizedCommand(node: WorkshopNode): WorkshopCommandConfiguration {
  return normalizedCommandFor(node.data);
}

/** Data-based variant of {@link normalizedCommand} for callers holding only `data` (faces). */
export function normalizedCommandFor(data: WorkshopNode['data']): WorkshopCommandConfiguration {
  return {
    executable: data.command?.executable ?? '',
    arguments: [...(data.command?.arguments ?? [])],
    ...(data.command?.cwdRelative === undefined ? {} : { cwdRelative: data.command.cwdRelative }),
    environmentNames: [...(data.command?.environmentNames ?? [])],
  };
}

function copyCommand(command: CommandConfiguration): WorkshopCommandConfiguration {
  return { executable: command.executable, arguments: [...command.arguments] };
}

function isCustomCheckId(value: string | undefined): value is string {
  if (value === undefined) return false;
  const parsed = CheckIdSchema.safeParse(value);
  return parsed.success && !BUILT_IN_CHECK_KINDS.has(parsed.data as CheckKind);
}

export function gateLabel(state: WorkshopNode['data']['gateState']): string {
  return {
    pending: 'Pending',
    passed: 'Passed',
    failed: 'Failed',
    'waiting-for-human': 'Waiting for you',
  }[state ?? 'pending'];
}

export function gateLabelFromView(state: WorkflowReviewGateView['status']): string {
  return gateLabel(state === 'waiting-human' ? 'waiting-for-human' : state);
}

/** Adapters that can act as a review-gate reviewer agent. */
export function reviewerAdapterSupported(adapterId: string): boolean {
  return adapterId === 'codex' || adapterId === 'claude';
}

export function reviewerOptionLabel(title: string, adapterId: string): string {
  return `${title} · ${adapterId}`;
}

/** Clamp a text-input integer into [minimum, maximum], falling back to the minimum. */
export function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.min(maximum, Math.max(minimum, parsed));
}
