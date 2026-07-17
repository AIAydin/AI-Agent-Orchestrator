import type { AppSettings, CommandConfiguration } from '../../../shared/application/contracts.js';
import type { CheckId, CheckKind } from '../../../shared/checks/contracts.js';
import { GitDeliveryAvailableCheckSchema } from '../../../shared/git/readiness/index.js';
import {
  DeliveryConfiguredCommandSchema,
  type DeliveryAvailableCheck,
  type DeliveryConfiguredCommand,
} from './contracts.js';
import { stableSha256 } from './fingerprints.js';

export interface DeliveryCheckDefinition {
  readonly checkId: CheckId;
  readonly label: string;
  readonly kind: CheckKind;
  readonly available: DeliveryAvailableCheck;
  readonly command: DeliveryConfiguredCommand | null;
}

const STANDARD_CHECKS: ReadonlyArray<{
  readonly checkId: CheckId;
  readonly label: string;
  readonly kind: Exclude<CheckKind, 'custom'>;
  readonly settingsKey: 'lintCommand' | 'typecheckCommand' | 'testCommand' | 'buildCommand';
}> = [
  { checkId: 'lint', label: 'Lint', kind: 'lint', settingsKey: 'lintCommand' },
  { checkId: 'typecheck', label: 'Typecheck', kind: 'typecheck', settingsKey: 'typecheckCommand' },
  { checkId: 'test', label: 'Tests', kind: 'test', settingsKey: 'testCommand' },
  { checkId: 'build', label: 'Build', kind: 'build', settingsKey: 'buildCommand' },
];

export function configuredDeliveryChecks(settings: AppSettings): DeliveryCheckDefinition[] {
  const definitions: DeliveryCheckDefinition[] = STANDARD_CHECKS.map((check) =>
    definition(
      check.checkId,
      check.label,
      check.kind,
      settings[check.settingsKey],
      settings.envAllowlist,
    ),
  );
  for (const custom of settings.customChecks ?? []) {
    definitions.push(
      definition(custom.id, custom.label, 'custom', custom.command, settings.envAllowlist),
    );
  }
  return definitions.sort((left, right) =>
    String(left.checkId).localeCompare(String(right.checkId)),
  );
}

export function requiredDeliveryChecks(
  settings: AppSettings,
  requiredCheckIds: readonly CheckId[],
): DeliveryCheckDefinition[] {
  const available = new Map(
    configuredDeliveryChecks(settings).map((check) => [String(check.checkId), check]),
  );
  return requiredCheckIds.map((checkId) => {
    const check = available.get(String(checkId));
    if (check === undefined)
      throw new Error(`Delivery check ${String(checkId)} is not configured.`);
    if (check.command === null || check.available.configurationDigest === null) {
      throw new Error(`Configure ${check.label} in Settings before requiring it for delivery.`);
    }
    return check;
  });
}

export function requiredCheckConfigurationDigest(
  definitions: readonly DeliveryCheckDefinition[],
): string {
  return stableSha256({
    schemaVersion: 1,
    checks: [...definitions]
      .sort((left, right) => String(left.checkId).localeCompare(String(right.checkId)))
      .map((check) => ({
        checkId: check.checkId,
        configurationDigest: check.available.configurationDigest,
      })),
  });
}

function definition(
  checkId: CheckId,
  label: string,
  kind: CheckKind,
  configured: CommandConfiguration,
  environmentNames: readonly string[],
): DeliveryCheckDefinition {
  const command =
    configured.executable.trim() === ''
      ? null
      : DeliveryConfiguredCommandSchema.parse({
          executable: configured.executable,
          args: configured.arguments,
          cwdRelative: '.',
          environmentNames: [...new Set(environmentNames)].sort(),
        });
  const configurationDigest =
    command === null ? null : stableSha256({ schemaVersion: 1, checkId, label, kind, command });
  return {
    checkId,
    label,
    kind,
    command,
    available: GitDeliveryAvailableCheckSchema.parse({
      checkId,
      label,
      kind,
      availability: command === null ? 'unconfigured' : 'configured',
      configurationDigest,
    }),
  };
}
