import type {
  AppSettings,
  CommandConfiguration,
} from '../../../../../shared/application/contracts.js';
import { CheckIdSchema, type CheckKind } from '../../../../../shared/checks/contracts.js';
import type { NodeKind, WorkshopCommandConfiguration, WorkshopNode } from '../canvas/CanvasNode.js';
import { permissionProfileUnavailableReason } from '../../permissions/permission-profile-ui.js';

const BUILT_IN_CHECK_KINDS = new Set<CheckKind>(['lint', 'typecheck', 'test', 'build']);

export interface WorkflowCommandPreset {
  readonly id: string;
  readonly label: string;
  readonly kind: NonNullable<WorkshopNode['data']['checkKind']>;
  readonly command: WorkshopCommandConfiguration;
}

export function initialWorkflowNodeData(
  kind: NodeKind,
  _nodeId: string,
  settings: AppSettings,
): Partial<WorkshopNode['data']> {
  if (kind === 'agent') {
    const adapterId = settings.defaultAgent;
    const permissionProfile =
      permissionProfileUnavailableReason(settings.defaultPermissionProfile, settings, adapterId) !==
      null
        ? 'worktree-write'
        : settings.defaultPermissionProfile;
    return { adapterId, permissionProfile };
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
      gateState: 'pending',
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

export function commandPresets(settings: AppSettings): readonly WorkflowCommandPreset[] {
  return [
    preset('lint', 'Project lint', 'lint', settings.lintCommand),
    preset('typecheck', 'Project typecheck', 'typecheck', settings.typecheckCommand),
    preset('test', 'Project tests', 'test', settings.testCommand),
    preset('build', 'Project build', 'build', settings.buildCommand),
    ...(settings.customChecks ?? []).map((check) =>
      preset(check.id, check.label, 'custom', check.command),
    ),
  ].filter((candidate) => candidate.command.executable.trim().length > 0);
}

export function checkProducerId(node: WorkshopNode): string {
  const kind = node.data.checkKind ?? 'test';
  if (kind !== 'custom') return kind;
  const configured = node.data.runIds?.[0];
  return isCustomCheckId(configured) ? configured : node.id;
}

export function producerIdForCheckKind(kind: CheckKind, current: string | undefined): string {
  if (kind !== 'custom') return kind;
  return isCustomCheckId(current) ? current : crypto.randomUUID();
}

export function normalizeCheckProducerData(data: WorkshopNode['data']): WorkshopNode['data'] {
  if (data.kind !== 'test') return data;
  const kind = data.checkKind ?? 'test';
  if (kind === 'custom' || (data.runIds?.length === 1 && data.runIds[0] === kind)) return data;
  return { ...data, checkKind: kind, runIds: [kind] };
}

export function parseLineList(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizedCommand(node: WorkshopNode): WorkshopCommandConfiguration {
  return {
    executable: node.data.command?.executable ?? '',
    arguments: [...(node.data.command?.arguments ?? [])],
    ...(node.data.command?.cwdRelative === undefined
      ? {}
      : { cwdRelative: node.data.command.cwdRelative }),
    environmentNames: [...(node.data.command?.environmentNames ?? [])],
  };
}

function preset(
  id: string,
  label: string,
  kind: WorkflowCommandPreset['kind'],
  command: CommandConfiguration,
): WorkflowCommandPreset {
  return { id, label, kind, command: copyCommand(command) };
}

function copyCommand(command: CommandConfiguration): WorkshopCommandConfiguration {
  return { executable: command.executable, arguments: [...command.arguments] };
}

function isCustomCheckId(value: string | undefined): value is string {
  if (value === undefined) return false;
  const parsed = CheckIdSchema.safeParse(value);
  return parsed.success && !BUILT_IN_CHECK_KINDS.has(parsed.data as CheckKind);
}
