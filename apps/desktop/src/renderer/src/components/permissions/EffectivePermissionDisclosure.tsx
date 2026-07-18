import type { RunDisclosure } from '../../../../shared/application/contracts.js';
import {
  accessPolicyWord,
  configuredFilesystemLabel,
  networkModeWord,
} from './permission-profile-ui.js';
import './permissions.css';

export function EffectivePermissionDisclosure({
  profile,
}: {
  profile: RunDisclosure['permissionProfile'];
}) {
  const custom = 'custom' in profile ? profile.custom : undefined;
  return (
    <section className="effective-permission-disclosure" aria-label="What this agent can do">
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
          Getting this run ready only used Docker to check basic engine and image details. The agent
          has not started inside Docker — it starts after you approve this exact launch.
        </p>
      )}
      {custom !== undefined && (
        <>
          <dl className="effective-permission-custom">
            <div>
              <dt>Where the agent runs</dt>
              <dd>
                {custom.runtime === 'docker'
                  ? 'In a Docker container (enforced by Docker)'
                  : 'On this computer (limits stated, not enforced)'}
              </dd>
            </div>
            <div>
              <dt>File access</dt>
              <dd>{configuredFilesystemLabel(custom.filesystem)}</dd>
            </div>
            <div>
              <dt>Ignored and sensitive files</dt>
              <dd>
                Ignored files {accessPolicyWord(custom.ignoredFileRead)} · sensitive files{' '}
                {accessPolicyWord(custom.sensitiveFileRead)}
              </dd>
            </div>
            <div>
              <dt>Program that starts the agent</dt>
              <dd>
                {custom.launchExecutablePolicy === 'selected-agent-only'
                  ? "Only the selected agent's program"
                  : custom.allowedLaunchExecutables.join(', ') || 'No programs listed'}
              </dd>
            </div>
            <div>
              <dt>Agent requests</dt>
              <dd>
                Dev servers {accessPolicyWord(custom.forgeboardManagedActions.developmentServers)} ·
                tests {accessPolicyWord(custom.forgeboardManagedActions.tests)} · requested, not
                enforced
              </dd>
            </div>
            <div>
              <dt>Main branch</dt>
              <dd>
                {custom.requireReviewBeforePrimary
                  ? 'Review always required'
                  : 'Invalid setup — do not approve'}
              </dd>
            </div>
            {custom.runtime === 'docker' && (
              <div>
                <dt>Docker network and limits</dt>
                <dd>
                  Network {networkModeWord(custom.docker.network)} · {custom.docker.cpuLimit} CPU
                  cores · {custom.docker.memoryMb} MB memory
                </dd>
              </div>
            )}
            {custom.runtime === 'docker' && (
              <div>
                <dt>Your sign-in details on this computer</dt>
                <dd>
                  {custom.docker.mountHostCredentials
                    ? 'Shared — invalid setup, do not approve'
                    : 'Not shared'}
                </dd>
              </div>
            )}
          </dl>
          {custom.policyLimitations.length > 0 && (
            <ul
              className="permission-limitations"
              aria-label="What these permissions can't guarantee"
            >
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
