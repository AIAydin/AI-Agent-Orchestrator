import { AlertTriangle, Container, ShieldCheck } from 'lucide-react';

import type { AppSettings, PermissionProfile } from '../../../../shared/application/contracts.js';
import {
  accessPolicyWord,
  configuredFilesystemLabel,
  permissionProfileLabel,
  permissionProfileUnavailableReason,
} from './permission-profile-ui.js';
import './permissions.css';

export function ConfiguredPermissionSummary({
  profile,
  settings,
}: {
  profile: PermissionProfile;
  settings: AppSettings;
}) {
  const unavailable = permissionProfileUnavailableReason(profile, settings);
  if (profile !== 'custom') {
    return (
      <div className="configured-permission-summary">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>
          <strong>{permissionProfileLabel(profile)}</strong>
          <small>{builtInSummary(profile)}</small>
          {profile === 'docker-isolated' && <DockerPreflightNotice />}
        </span>
        {unavailable && <em>{unavailable}</em>}
      </div>
    );
  }
  const custom = settings.customPermissionProfile;
  return (
    <div className="configured-permission-summary custom">
      {custom.runtime === 'docker' ? (
        <Container size={15} aria-hidden="true" />
      ) : (
        <AlertTriangle size={15} aria-hidden="true" />
      )}
      <span>
        <strong>
          Custom ·{' '}
          {custom.runtime === 'docker'
            ? 'runs in Docker (enforced)'
            : 'runs on this computer (not enforced)'}
        </strong>
        <small>{configuredFilesystemLabel(custom.filesystem)}</small>
        <small>
          Ignored files {accessPolicyWord(custom.ignoredFileRead)} · sensitive files{' '}
          {accessPolicyWord(custom.sensitiveFileRead)} · dev servers{' '}
          {accessPolicyWord(custom.forgeboardManagedActions.developmentServers)} · tests{' '}
          {accessPolicyWord(custom.forgeboardManagedActions.tests)}
        </small>
        <small>You always review changes before they reach the main branch.</small>
        {custom.runtime === 'docker' && <DockerPreflightNotice />}
      </span>
      {unavailable && <em>{unavailable}</em>}
    </div>
  );
}

function DockerPreflightNotice() {
  return (
    <small>
      “Review &amp; run” only checks basic engine and image details. Nothing starts inside Docker
      until you approve the exact launch.
    </small>
  );
}

function builtInSummary(profile: Exclude<PermissionProfile, 'custom'>): string {
  switch (profile) {
    case 'plan-read-only':
      return 'The agent is asked to only read and plan. It starts after you approve the exact launch.';
    case 'worktree-write':
      return 'The agent works in its own worktree. You review changes before they reach the main branch.';
    case 'project-write':
      return 'The agent works right in your project folder. Changes land directly in your files.';
    case 'docker-isolated':
      return 'Runs in Docker without admin rights, limited to one worktree, with network and resource limits.';
  }
}
