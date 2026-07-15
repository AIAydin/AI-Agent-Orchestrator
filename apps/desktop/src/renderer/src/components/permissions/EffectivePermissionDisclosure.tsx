import type { RunDisclosure } from '../../../../shared/contracts.js';
import { configuredFilesystemLabel } from './permission-profile-ui.js';
import './permissions.css';

export function EffectivePermissionDisclosure({
  profile,
}: {
  profile: RunDisclosure['permissionProfile'];
}) {
  const custom = 'custom' in profile ? profile.custom : undefined;
  return (
    <section className="effective-permission-disclosure" aria-label="Effective permission profile">
      <p>
        <strong>{profile.name}</strong> · {profile.mode} · {profile.enforcement}
      </p>
      <p>
        <strong>Read:</strong> {profile.readRoots.join(', ') || 'none'}
        <br />
        <strong>Write:</strong> {profile.writeRoots.join(', ') || 'none'}
        <br />
        <strong>Network:</strong> {profile.network}
      </p>
      {profile.enforcement === 'docker' && (
        <p className="permission-caution">
          Preparation invoked the selected Docker client only for bounded daemon and image metadata
          preflight. The in-image agent payload has not started; this exact launch still needs your
          approval.
        </p>
      )}
      {custom !== undefined && (
        <>
          <dl className="effective-permission-custom">
            <div>
              <dt>Runtime boundary</dt>
              <dd>
                {custom.runtime === 'docker'
                  ? 'Docker technical boundary'
                  : 'Host disclosure-only policy'}
              </dd>
            </div>
            <div>
              <dt>Filesystem policy</dt>
              <dd>{configuredFilesystemLabel(custom.filesystem)}</dd>
            </div>
            <div>
              <dt>Worktree content visibility</dt>
              <dd>
                Ignored {custom.ignoredFileRead} · sensitive {custom.sensitiveFileRead}
              </dd>
            </div>
            <div>
              <dt>Top-level executable policy</dt>
              <dd>
                {custom.launchExecutablePolicy === 'selected-agent-only'
                  ? 'Selected agent only'
                  : custom.allowedLaunchExecutables.join(', ') || 'No executable configured'}
              </dd>
            </div>
            <div>
              <dt>Requested agent actions</dt>
              <dd>
                Dev servers {custom.forgeboardManagedActions.developmentServers} · tests{' '}
                {custom.forgeboardManagedActions.tests} · advisory
              </dd>
            </div>
            <div>
              <dt>Primary branch</dt>
              <dd>
                {custom.requireReviewBeforePrimary
                  ? 'Review always required'
                  : 'Invalid disclosure'}
              </dd>
            </div>
            {custom.runtime === 'docker' && (
              <div>
                <dt>Docker network and resources</dt>
                <dd>
                  Network {custom.docker.network} · {custom.docker.cpuLimit} CPU ·{' '}
                  {custom.docker.memoryMb} MB memory
                </dd>
              </div>
            )}
            {custom.runtime === 'docker' && (
              <div>
                <dt>Host credentials</dt>
                <dd>{custom.docker.mountHostCredentials ? 'Invalid disclosure' : 'Not mounted'}</dd>
              </div>
            )}
          </dl>
          {custom.policyLimitations.length > 0 && (
            <ul className="permission-limitations" aria-label="Permission policy limitations">
              {custom.policyLimitations.map((limitation: string) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
