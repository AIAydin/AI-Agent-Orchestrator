import {
  detectAgent,
  AgentAdapterManifestSchema,
  getBuiltInAgentManifest,
  locateAgentExecutable,
  type AgentAdapterManifest,
  type AgentDetectionResult,
} from '@forgeboard/agent-adapters';
import { TEST_AGENT_MANIFEST } from '@forgeboard/test-agent';

import {
  AgentReadinessRequestSchema,
  AgentReadinessResultSchema,
  type AgentReadinessRequest,
  type AgentReadinessResult,
} from '../../shared/readiness/contracts.js';
import { customAgentManifest } from '../custom-agent/custom-agent.js';
import {
  readinessExecutableIdentity,
  sameReadinessExecutable,
  type ReadinessExecutableIdentity,
} from './executable-identity.js';

type LocateExecutable = typeof locateAgentExecutable;
type ProbeAgent = typeof detectAgent;
type IdentifyExecutable = typeof readinessExecutableIdentity;

const READINESS_PLAN_TTL_MS = 5 * 60_000;

export interface AgentReadinessServiceDependencies {
  readonly locateExecutable?: LocateExecutable;
  readonly probeAgent?: ProbeAgent;
  readonly identifyExecutable?: IdentifyExecutable;
  readonly now?: () => Date;
}

export interface AgentReadinessProbePlan {
  readonly request: AgentReadinessRequest;
  readonly source: AgentReadinessResult['source'];
  readonly manifest: AgentAdapterManifest;
  readonly executable: string;
  readonly executableIdentity: ReadinessExecutableIdentity;
  readonly versionArguments: readonly string[];
  readonly capabilityArguments: readonly string[] | null;
  readonly providerName: string;
  readonly providerDisclosure: string;
  readonly expiresAtMs: number;
}

export type AgentReadinessPreparation =
  | { readonly outcome: 'result'; readonly result: AgentReadinessResult }
  | { readonly outcome: 'probe'; readonly plan: AgentReadinessProbePlan };

/**
 * Main-process-only verifier for a selected agent executable.
 *
 * The request contains the current UI draft, so checking an override never persists it. Passive
 * location happens first; only the explicitly requested candidate then runs its bounded version
 * and capability probes.
 */
export class AgentReadinessService {
  readonly #locateExecutable: LocateExecutable;
  readonly #probeAgent: ProbeAgent;
  readonly #identifyExecutable: IdentifyExecutable;
  readonly #now: () => Date;

  public constructor(
    private readonly testAgentPath: string,
    dependencies: AgentReadinessServiceDependencies = {},
  ) {
    this.#locateExecutable = dependencies.locateExecutable ?? locateAgentExecutable;
    this.#probeAgent = dependencies.probeAgent ?? detectAgent;
    this.#identifyExecutable = dependencies.identifyExecutable ?? readinessExecutableIdentity;
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async check(input: unknown): Promise<AgentReadinessResult> {
    const prepared = await this.prepare(input);
    return prepared.outcome === 'result' ? prepared.result : await this.probe(prepared.plan);
  }

  /** Performs validation and passive executable discovery without starting a process. */
  public async prepare(input: unknown): Promise<AgentReadinessPreparation> {
    const request = AgentReadinessRequestSchema.parse(input);
    const source = readinessSource(request);
    let manifest: AgentAdapterManifest;
    try {
      manifest = manifestForRequest(request);
    } catch (error) {
      return {
        outcome: 'result',
        result: this.#result(request, source, 'invalid-configuration', {
          reason: errorMessage(error, 'The selected agent configuration is invalid.'),
        }),
      };
    }

    const requestedExecutable = executableForRequest(request, this.testAgentPath, manifest);
    let located: AgentDetectionResult;
    try {
      located = await this.#locateExecutable(manifest, { executable: requestedExecutable });
    } catch (error) {
      return {
        outcome: 'result',
        result: this.#result(request, source, 'executable-missing', {
          executable: requestedExecutable,
          reason: errorMessage(error, 'The selected executable could not be inspected.'),
        }),
      };
    }
    if (!located.available) {
      return {
        outcome: 'result',
        result: this.#result(request, source, 'executable-missing', {
          executable: located.executable,
          reason:
            located.reason ??
            'The selected executable was not found or is not an executable regular file.',
          warnings: located.capabilityWarnings,
          checkedAt: located.checkedAt,
        }),
      };
    }
    if (located.adapterId !== manifest.id) {
      return {
        outcome: 'result',
        result: this.#result(request, source, 'probe-failed', {
          executable: located.executable,
          reason: 'Executable discovery returned evidence for a different agent adapter.',
          checkedAt: located.checkedAt,
        }),
      };
    }

    try {
      const executableIdentity = await this.#identifyExecutable(located.executable);
      return {
        outcome: 'probe',
        plan: {
          request,
          source,
          manifest,
          executable: located.executable,
          executableIdentity,
          versionArguments: [...manifest.executable.versionArguments],
          capabilityArguments: manifest.executable.capabilityProbe?.arguments ?? null,
          providerName: manifest.provider.name,
          providerDisclosure: manifest.provider.disclosure,
          expiresAtMs: this.#validNow().getTime() + READINESS_PLAN_TTL_MS,
        },
      };
    } catch (error) {
      return {
        outcome: 'result',
        result: this.#result(request, source, 'probe-failed', {
          executable: located.executable,
          reason: errorMessage(error, 'The selected executable identity could not be verified.'),
          checkedAt: located.checkedAt,
        }),
      };
    }
  }

  /** Revalidates the exact executable after native approval, then performs bounded probes. */
  public async probe(
    plan: AgentReadinessProbePlan,
    authorizeProbe: (() => void) | undefined = undefined,
  ): Promise<AgentReadinessResult> {
    const { request, source, manifest } = plan;
    let located: AgentDetectionResult;
    try {
      located = await this.#locateExecutable(manifest, { executable: plan.executable });
      if (
        !located.available ||
        located.adapterId !== manifest.id ||
        located.executable !== plan.executable
      ) {
        throw new Error('The selected executable changed after approval. Review it again.');
      }
      const currentIdentity = await this.#identifyExecutable(located.executable);
      if (!sameReadinessExecutable(plan.executableIdentity, currentIdentity)) {
        throw new Error('The selected executable changed after approval. Review it again.');
      }
    } catch (error) {
      return this.#result(request, source, 'probe-failed', {
        executable: plan.executable,
        reason: errorMessage(error, 'The selected executable changed after approval.'),
      });
    }

    let detection: AgentDetectionResult;
    try {
      detection = await this.#probeAgent(manifest, {
        executable: located.executable,
        beforeProbe: async () => {
          const currentIdentity = await this.#identifyExecutable(plan.executable);
          if (!sameReadinessExecutable(plan.executableIdentity, currentIdentity)) {
            throw new Error('The selected executable changed after approval. Review it again.');
          }
          authorizeProbe?.();
        },
      });
    } catch (error) {
      return this.#result(request, source, 'probe-failed', {
        executable: located.executable,
        reason: errorMessage(error, 'The selected executable could not report its version.'),
        checkedAt: located.checkedAt,
      });
    }
    if (!detection.available) {
      return this.#result(request, source, 'probe-failed', {
        executable: located.executable,
        reason: detection.reason ?? 'The selected executable failed its version probe.',
        warnings: detection.capabilityWarnings,
        checkedAt: detection.checkedAt,
      });
    }
    if (detection.adapterId !== manifest.id || detection.executable !== located.executable) {
      return this.#result(request, source, 'probe-failed', {
        executable: located.executable,
        reason: 'The version probe did not match the selected executable and agent adapter.',
        warnings: detection.capabilityWarnings,
        checkedAt: detection.checkedAt,
      });
    }

    const version = validatedVersion(manifest, detection);
    if (version === null) {
      return this.#result(request, source, 'probe-failed', {
        executable: located.executable,
        reason:
          manifest.executable.versionPattern === undefined
            ? 'The version probe succeeded but returned no version text.'
            : 'The version output did not match the selected agent adapter.',
        warnings: detection.capabilityWarnings,
        checkedAt: detection.checkedAt,
      });
    }
    return this.#result(request, source, 'ready', {
      executable: located.executable,
      version,
      warnings: detection.capabilityWarnings,
      checkedAt: detection.checkedAt,
    });
  }

  #result(
    request: AgentReadinessRequest,
    source: AgentReadinessResult['source'],
    state: AgentReadinessResult['state'],
    details: {
      readonly executable?: string | null;
      readonly version?: string | null;
      readonly reason?: string;
      readonly warnings?: readonly string[];
      readonly checkedAt?: string;
    },
  ): AgentReadinessResult {
    const ready = state === 'ready';
    return AgentReadinessResultSchema.parse({
      schemaVersion: 1,
      agentId: request.agentId,
      state,
      ready,
      source,
      executable: details.executable ?? null,
      version: details.version ?? null,
      checkedAt: details.checkedAt ?? this.#now().toISOString(),
      reason: ready ? null : (details.reason ?? 'The selected agent is not ready.'),
      warnings: [...(details.warnings ?? [])],
    });
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error('Readiness time must be valid.');
    return now;
  }
}

function manifestForRequest(request: AgentReadinessRequest): AgentAdapterManifest {
  if (request.agentId === 'custom') return customAgentManifest(request.configuration);
  if (request.agentId === 'test-agent') {
    return AgentAdapterManifestSchema.parse({ ...TEST_AGENT_MANIFEST, id: 'test-agent' });
  }
  const manifest = getBuiltInAgentManifest(request.agentId);
  if (manifest === undefined) throw new Error(`Unsupported readiness agent: ${request.agentId}`);
  return manifest;
}

function executableForRequest(
  request: AgentReadinessRequest,
  testAgentPath: string,
  manifest: AgentAdapterManifest,
): string {
  if (request.agentId === 'test-agent') return testAgentPath;
  if (request.agentId === 'custom') return request.configuration.executable;
  return request.executableOverride ?? manifest.executable.command;
}

function readinessSource(request: AgentReadinessRequest): AgentReadinessResult['source'] {
  if (request.agentId === 'test-agent') return 'bundled';
  if (request.agentId === 'custom') return 'custom';
  return request.executableOverride === undefined ? 'automatic' : 'override';
}

function validatedVersion(
  manifest: AgentAdapterManifest,
  detection: AgentDetectionResult,
): string | null {
  if (detection.version?.trim()) return detection.version.trim().slice(0, 512);
  if (manifest.executable.versionPattern !== undefined) return null;
  const firstLine = detection.rawVersion
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 512) ?? null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message.slice(0, 4_096)
    : fallback;
}
