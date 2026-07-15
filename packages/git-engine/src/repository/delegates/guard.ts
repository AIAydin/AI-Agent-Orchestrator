import { createHash } from 'node:crypto';

import { GitEngineError } from '../../model/errors.js';
import type {
  GitActiveFilter,
  GitDelegateAuthorizer,
  GitConfiguredDelegate,
  GitDelegateGuardInput,
  GitDelegateInspection,
  GitDelegatePlan,
  GitDelegatePlanDeclaration,
  GitConfiguredMergeDriver,
} from './contracts.js';
import { GitDelegateApprovalRequiredError } from './error.js';

interface RawGitResult {
  readonly stdout: string;
  readonly exitCode: number;
}

interface RawGitOptions {
  readonly allowNonZeroExit?: boolean;
  readonly input?: string | Uint8Array;
  readonly maxOutputBytes?: number;
}

export type RawGitRunner = (
  args: readonly string[],
  options?: RawGitOptions,
) => Promise<RawGitResult>;

const FILTER_CONFIGURATION_PATTERN = '^filter\\..*\\.(clean|smudge|process|required)$';
const MERGE_DRIVER_CONFIGURATION_PATTERN = '^merge\\..*\\.driver$';
const SAFE_DRIVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAX_DISCLOSED_PATHS = 32;

/**
 * Uses only Git metadata commands. `config`, `ls-files`, and `check-attr` read declarations but
 * never invoke the commands declared by filter drivers.
 */
export async function inspectGitDelegates(
  run: RawGitRunner,
  input: GitDelegateGuardInput,
  authorize?: GitDelegateAuthorizer,
): Promise<GitDelegateInspection> {
  const initial = await inspectSnapshot(run, input);
  assertNoCustomMergeDrivers(input, initial.configuredMergeDrivers);
  const initialPlan = delegatePlan(input, initial.activeFilters, initial.configuredDelegates);
  if (initialPlan === null) {
    return {
      ...initial,
      neutralizingArguments: neutralizingArguments(initial.configuredDelegates),
      authorization: null,
    };
  }
  if (initialPlan.filters.some((filter) => !filter.executableConfigured)) {
    throw new GitDelegateApprovalRequiredError(initialPlan, 'configuration-missing');
  }
  if (authorize === undefined) {
    throw new GitDelegateApprovalRequiredError(initialPlan, 'approval-required');
  }
  const authorization = await authorize(initialPlan);
  if (authorization === null) {
    throw new GitDelegateApprovalRequiredError(initialPlan, 'approval-cancelled');
  }
  if (authorization.fingerprint !== initialPlan.fingerprint) {
    throw new GitDelegateApprovalRequiredError(initialPlan, 'plan-changed');
  }
  const current = await inspectSnapshot(run, input);
  assertNoCustomMergeDrivers(input, current.configuredMergeDrivers);
  const currentPlan = delegatePlan(input, current.activeFilters, current.configuredDelegates);
  if (currentPlan?.fingerprint !== initialPlan.fingerprint) {
    throw new GitDelegateApprovalRequiredError(currentPlan ?? initialPlan, 'plan-changed');
  }
  return {
    ...current,
    neutralizingArguments: authorizedArguments(current.configuredDelegates, currentPlan),
    authorization,
  };
}

async function inspectSnapshot(
  run: RawGitRunner,
  input: GitDelegateGuardInput,
): Promise<
  Pick<GitDelegateInspection, 'activeFilters' | 'configuredDelegates' | 'configuredMergeDrivers'>
> {
  const configuredDelegates = await configuredFilterDelegates(run, input.repositoryPath);
  const configuredMergeDrivers =
    input.operation === 'history-update'
      ? await configuredCustomMergeDrivers(run, input.repositoryPath)
      : [];
  const activeFilters =
    input.operation === 'object-inspection' ? [] : await activeFiltersForPaths(run, input);
  return { activeFilters, configuredDelegates, configuredMergeDrivers };
}

function assertNoCustomMergeDrivers(
  input: GitDelegateGuardInput,
  drivers: readonly GitConfiguredMergeDriver[],
): void {
  if (input.operation !== 'history-update' || drivers.length === 0) return;
  throw new GitEngineError(
    'EXTERNAL_DRIVER_BLOCKED',
    'Forgeboard blocked this history update because Git custom merge drivers can execute external commands. No merge driver was run.',
    {
      reason: 'custom-merge-driver',
      repositoryPath: input.repositoryPath,
      drivers,
    },
  );
}

async function configuredFilterDelegates(
  run: RawGitRunner,
  repositoryPath: string,
): Promise<readonly GitConfiguredDelegate[]> {
  const result = await run(
    [
      '-C',
      repositoryPath,
      'config',
      '--null',
      '--show-origin',
      '--get-regexp',
      FILTER_CONFIGURATION_PATTERN,
    ],
    { allowNonZeroExit: true },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      "Forgeboard could not safely inspect this repository's Git filter configuration.",
      { repositoryPath },
    );
  }
  if (result.exitCode === 1 || result.stdout === '') return [];
  return parseConfiguredDelegates(result.stdout);
}

function parseConfiguredDelegates(output: string): readonly GitConfiguredDelegate[] {
  const records = output.split('\0').filter((record) => record !== '');
  const parsed: GitConfiguredDelegate[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const origin = records[index];
    const declaration = records[index + 1];
    if (origin === undefined || declaration === undefined) {
      throw malformedConfigurationError();
    }
    const separator = declaration.indexOf('\n');
    if (separator <= 0) throw malformedConfigurationError();
    const key = declaration.slice(0, separator);
    const command = declaration.slice(separator + 1);
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/iu.exec(key);
    if (match?.[1] === undefined || match[2] === undefined) throw malformedConfigurationError();
    const driver = match[1];
    if (!SAFE_DRIVER_NAME.test(driver)) {
      throw new GitEngineError(
        'EXTERNAL_DRIVER_BLOCKED',
        'Forgeboard blocked a Git filter with an unsupported driver name.',
        { driver, origin },
      );
    }
    parsed.push({
      driver,
      phase: match[2].toLowerCase() as GitConfiguredDelegate['phase'],
      command,
      origin,
    });
  }
  return parsed;
}

async function configuredCustomMergeDrivers(
  run: RawGitRunner,
  repositoryPath: string,
): Promise<readonly GitConfiguredMergeDriver[]> {
  const result = await run(
    [
      '-C',
      repositoryPath,
      'config',
      '--null',
      '--show-origin',
      '--get-regexp',
      MERGE_DRIVER_CONFIGURATION_PATTERN,
    ],
    { allowNonZeroExit: true },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      "Forgeboard could not safely inspect this repository's Git merge-driver configuration.",
      { repositoryPath },
    );
  }
  if (result.exitCode === 1 || result.stdout === '') return [];
  const records = result.stdout.split('\0').filter((record) => record !== '');
  const parsed: GitConfiguredMergeDriver[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const origin = records[index];
    const declaration = records[index + 1];
    if (origin === undefined || declaration === undefined) throw malformedConfigurationError();
    const separator = declaration.indexOf('\n');
    if (separator <= 0) throw malformedConfigurationError();
    const key = declaration.slice(0, separator);
    const command = declaration.slice(separator + 1);
    const match = /^merge\.(.+)\.driver$/iu.exec(key);
    if (match?.[1] === undefined || !SAFE_DRIVER_NAME.test(match[1])) {
      throw new GitEngineError(
        'EXTERNAL_DRIVER_BLOCKED',
        'Forgeboard blocked a Git merge driver with an unsupported name.',
        { key, origin },
      );
    }
    if (command.trim() !== '') parsed.push({ driver: match[1], command, origin });
  }
  return parsed;
}

function malformedConfigurationError(): GitEngineError {
  return new GitEngineError(
    'EXTERNAL_DRIVER_BLOCKED',
    'Forgeboard blocked malformed Git filter configuration before running repository content.',
  );
}

async function activeFiltersForPaths(
  run: RawGitRunner,
  input: GitDelegateGuardInput,
): Promise<readonly GitActiveFilter[]> {
  const source = input.attributeSource ?? 'worktree';
  const paths =
    input.paths === undefined ? await listCandidatePaths(run, input, source) : input.paths;
  assertPaths(paths);
  if (paths.length === 0) return [];
  const args = ['-C', input.repositoryPath, 'check-attr'];
  if (source === 'index') args.push('--cached');
  args.push('-z', '--stdin', 'filter');
  const result = await run(args, {
    input: `${paths.join('\0')}\0`,
    maxOutputBytes: Math.max(1024 * 1024, paths.join('').length * 4),
  });
  return parseActiveFilters(result.stdout);
}

async function listCandidatePaths(
  run: RawGitRunner,
  input: GitDelegateGuardInput,
  source: 'index' | 'worktree',
): Promise<readonly string[]> {
  const args = ['-C', input.repositoryPath, 'ls-files', '--cached'];
  if (source === 'worktree') args.push('--others', '--exclude-standard');
  args.push('-z');
  const result = await run(args);
  return result.stdout.split('\0').filter((path) => path !== '');
}

function assertPaths(paths: readonly string[]): void {
  for (const candidate of paths) {
    if (candidate === '' || candidate.includes('\0')) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'Git delegate inspection received an invalid path.',
      );
    }
  }
}

function parseActiveFilters(output: string): readonly GitActiveFilter[] {
  if (output === '') return [];
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 3 !== 0) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      'Forgeboard blocked malformed Git attribute output before running repository content.',
    );
  }
  const pathsByDriver = new Map<string, Set<string>>();
  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (path === undefined || attribute !== 'filter' || value === undefined) {
      throw new GitEngineError(
        'EXTERNAL_DRIVER_BLOCKED',
        'Forgeboard blocked malformed Git filter attributes before running repository content.',
      );
    }
    if (value === 'unspecified' || value === 'unset') continue;
    const paths = pathsByDriver.get(value) ?? new Set<string>();
    paths.add(path);
    pathsByDriver.set(value, paths);
  }
  return [...pathsByDriver.entries()]
    .map(([driver, paths]) => ({ driver, paths: [...paths].sort() }))
    .sort((left, right) => left.driver.localeCompare(right.driver));
}

function delegatePlan(
  input: GitDelegateGuardInput,
  activeFilters: readonly GitActiveFilter[],
  configured: readonly GitConfiguredDelegate[],
): GitDelegatePlan | null {
  const operation = input.operation;
  if (operation === 'object-inspection' || activeFilters.length === 0) return null;
  const configuredByDriver = new Map<string, GitConfiguredDelegate[]>();
  for (const delegate of configured) {
    const entries = configuredByDriver.get(delegate.driver.toLowerCase()) ?? [];
    entries.push(delegate);
    configuredByDriver.set(delegate.driver.toLowerCase(), entries);
  }
  const plannedFilters = activeFilters.flatMap((filter) => {
    const declarations = configuredByDriver.get(filter.driver.toLowerCase()) ?? [];
    const relevant = declarations.filter((entry) => relevantPhase(operation, entry.phase));
    const executable = relevant.filter(
      (entry) => entry.phase !== 'required' && entry.command.trim() !== '',
    );
    const required = effectiveRequired(relevant);
    if (executable.length === 0 && !required) return [];
    const pathDigest = createHash('sha256').update(filter.paths.join('\0')).digest('hex');
    return [
      {
        driver: filter.driver,
        executableConfigured: executable.length > 0,
        pathCount: filter.paths.length,
        pathDigest,
        disclosedPaths: filter.paths.slice(0, MAX_DISCLOSED_PATHS),
        pathsTruncated: filter.paths.length > MAX_DISCLOSED_PATHS,
        declarations: relevant.map(({ phase, command, origin }) => ({ phase, command, origin })),
      },
    ];
  });
  if (plannedFilters.length === 0) return null;
  const payload = {
    schemaVersion: 1 as const,
    repositoryPath: input.repositoryPath,
    operation,
    filters: plannedFilters,
  };
  return {
    ...payload,
    fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

function relevantPhase(
  operation: Exclude<GitDelegateGuardInput['operation'], 'object-inspection'>,
  phase: GitConfiguredDelegate['phase'],
): boolean {
  if (phase === 'required' || phase === 'process') return true;
  if (operation === 'checkout-smudge' || operation === 'history-update') {
    return phase === 'clean' || phase === 'smudge';
  }
  return phase === 'clean';
}

function effectiveRequired(declarations: readonly GitConfiguredDelegate[]): boolean {
  const value = declarations
    .filter(({ phase }) => phase === 'required')
    .at(-1)
    ?.command.trim();
  return value !== undefined && /^(?:1|on|true|yes)$/iu.test(value);
}

function neutralizingArguments(configured: readonly GitConfiguredDelegate[]): readonly string[] {
  const drivers = [...new Set(configured.map(({ driver }) => driver))].sort();
  return drivers.flatMap((driver) => [
    '-c',
    `filter.${driver}.process=`,
    '-c',
    `filter.${driver}.clean=`,
    '-c',
    `filter.${driver}.smudge=`,
    '-c',
    `filter.${driver}.required=false`,
  ]);
}

function authorizedArguments(
  configured: readonly GitConfiguredDelegate[],
  plan: GitDelegatePlan,
): readonly string[] {
  const drivers = [
    ...new Set([
      ...configured.map(({ driver }) => driver),
      ...plan.filters.map(({ driver }) => driver),
    ]),
  ].sort();
  const arguments_: string[] = [];
  for (const driver of drivers) {
    const planned = plan.filters.find(
      (filter) => filter.driver.toLowerCase() === driver.toLowerCase(),
    );
    if (planned === undefined) {
      arguments_.push(
        ...neutralizingArguments(configured.filter((entry) => entry.driver === driver)),
      );
      continue;
    }
    for (const declaration of effectiveDeclarations(planned.declarations)) {
      if (declaration.phase !== 'required' && declaration.command.trim() === '') continue;
      arguments_.push('-c', `filter.${driver}.${declaration.phase}=${declaration.command}`);
    }
  }
  return arguments_;
}

function effectiveDeclarations(
  declarations: readonly GitDelegatePlanDeclaration[],
): readonly GitDelegatePlanDeclaration[] {
  const latest = new Map<GitDelegatePlanDeclaration['phase'], GitDelegatePlanDeclaration>();
  for (const declaration of declarations) latest.set(declaration.phase, declaration);
  return [...latest.values()].sort((left, right) => left.phase.localeCompare(right.phase));
}
