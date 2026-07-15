import { AlertTriangle, Container, ShieldCheck } from 'lucide-react';

import type { AppSettings, PermissionProfile } from '../../../../shared/contracts.js';
import {
  configuredFilesystemLabel,
  permissionProfileLabel,
  permissionProfileUnavailableReason,
} from './permission-profile-ui.js';
import './permissions.css';

export function ConfiguredPermissionSummary({
  profile,
  settings,
  adapterId,
}: {
  profile: PermissionProfile;
  settings: AppSettings;
  adapterId: string;
}) {
  const unavailable = permissionProfileUnavailableReason(profile, settings, adapterId);
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
          Custom · {custom.runtime === 'docker' ? 'Docker boundary' : 'host disclosure-only'}
        </strong>
        <small>{configuredFilesystemLabel(custom.filesystem)}</small>
        <small>
          Ignored {custom.ignoredFileRead} · sensitive {custom.sensitiveFileRead} · dev servers{' '}
          {custom.forgeboardManagedActions.developmentServers} · tests{' '}
          {custom.forgeboardManagedActions.tests}
        </small>
        <small>Primary-branch review always required.</small>
        {custom.runtime === 'docker' && <DockerPreflightNotice />}
      </span>
      {unavailable && <em>{unavailable}</em>}
    </div>
  );
}

function DockerPreflightNotice() {
  return (
    <small>
      Review &amp; run invokes the selected Docker client for bounded daemon and image metadata
      preflight. No in-image agent payload starts until you approve the exact launch.
    </small>
  );
}

function builtInSummary(profile: Exclude<PermissionProfile, 'custom'>): string {
  switch (profile) {
    case 'plan-read-only':
      return 'Provider read-only request; the exact launch remains approval-gated.';
    case 'worktree-write':
      return 'Dedicated managed worktree; changes require review before the primary branch.';
    case 'docker-isolated':
      return 'Non-root container, one worktree mount, network and resource controls.';
  }
}
