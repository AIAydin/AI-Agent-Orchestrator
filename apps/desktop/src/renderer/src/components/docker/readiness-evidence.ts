import type { AppSettings } from '../../../../shared/application/contracts.js';
import {
  DockerReadinessInputSchema,
  type DockerReadiness,
  type DockerReadinessInput,
} from '../../../../shared/docker/contracts.js';

type DockerConfigurationValue = Pick<
  AppSettings,
  'dockerExecutable' | 'dockerImage' | 'dockerContainerExecutable'
>;

export interface DockerReadinessEvidence {
  readonly request: DockerReadinessInput;
  readonly readiness: DockerReadiness;
}

export function dockerReadinessRequest(
  value: DockerConfigurationValue,
): DockerReadinessInput | null {
  const parsed = DockerReadinessInputSchema.safeParse({
    dockerExecutable: value.dockerExecutable.trim(),
    image: value.dockerImage.trim(),
    containerExecutable: value.dockerContainerExecutable.trim(),
  });
  return parsed.success ? parsed.data : null;
}

export function dockerEvidenceMatches(
  value: DockerConfigurationValue,
  evidence: DockerReadinessEvidence | null,
): boolean {
  const request = dockerReadinessRequest(value);
  if (request === null || evidence === null) return false;
  const readiness = evidence.readiness;
  return (
    dockerEvidenceBelongsTo(value, evidence) &&
    readiness.available &&
    readiness.status === 'ready' &&
    readiness.executableAvailable &&
    readiness.daemonAvailable &&
    readiness.imageAvailable &&
    readiness.imageCompatible &&
    readiness.containerExecutableAvailable &&
    readiness.image === request.image &&
    readiness.containerExecutable === request.containerExecutable
  );
}

export function dockerEvidenceBelongsTo(
  value: DockerConfigurationValue,
  evidence: DockerReadinessEvidence | null,
): boolean {
  const request = dockerReadinessRequest(value);
  return request !== null && evidence !== null && dockerRequestsMatch(request, evidence.request);
}

export function dockerReadinessIssue(
  draft: AppSettings,
  evidence: DockerReadinessEvidence | null,
  current?: AppSettings,
): string | undefined {
  if (!draft.dockerEnabled) return undefined;
  if (dockerReadinessRequest(draft) === null || draft.dockerMountHostCredentials) {
    return 'Complete the selected Docker configuration before saving.';
  }
  if (current !== undefined && !dockerSettingsReadinessChanged(current, draft)) return undefined;
  if (!dockerEvidenceMatches(draft, evidence)) {
    return (
      evidence?.readiness.reason?.trim() ||
      'Run Check Docker successfully for the current executable, image, and container executable before saving.'
    );
  }
  return undefined;
}

export function dockerSettingsReadinessChanged(current: AppSettings, next: AppSettings): boolean {
  return (
    next.dockerEnabled &&
    (!current.dockerEnabled ||
      current.dockerExecutable !== next.dockerExecutable ||
      current.dockerImage !== next.dockerImage ||
      current.dockerContainerExecutable !== next.dockerContainerExecutable)
  );
}

export function dockerRequestsMatch(
  left: DockerReadinessInput,
  right: DockerReadinessInput,
): boolean {
  return (
    left.dockerExecutable === right.dockerExecutable &&
    left.image === right.image &&
    left.containerExecutable === right.containerExecutable
  );
}
