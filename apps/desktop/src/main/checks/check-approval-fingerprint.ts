import { createHash } from 'node:crypto';

import type { CheckId, CheckKind } from '../../shared/checks/contracts.js';
import type { FileIdentity } from './check-process.js';

export interface CheckApprovalBinding {
  readonly projectId: string;
  readonly checkId: CheckId;
  readonly label: string;
  readonly kind: CheckKind;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environmentVariableNames: readonly string[];
  readonly rootIdentity: FileIdentity;
  readonly executableIdentities: readonly FileIdentity[];
}

/**
 * Binds a reusable approval to the exact resolved project, command, repository root, executable,
 * and package-script bytes without exposing environment values or host file contents.
 */
export function checkApprovalFingerprint(binding: CheckApprovalBinding): string {
  const payload = {
    schemaVersion: 2,
    projectId: binding.projectId,
    checkId: binding.checkId,
    label: binding.label,
    kind: binding.kind,
    executable: binding.executable,
    arguments: [...binding.arguments],
    cwd: binding.cwd,
    environmentVariableNames: [...binding.environmentVariableNames],
    rootIdentity: identityPayload(binding.rootIdentity),
    executableIdentities: binding.executableIdentities.map(identityPayload),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function identityPayload(identity: FileIdentity) {
  return {
    path: identity.path,
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    mode: identity.mode,
    modifiedAtMs: identity.modifiedAtMs,
    changedAtMs: identity.changedAtMs,
    contentDigest: identity.contentDigest,
  };
}
