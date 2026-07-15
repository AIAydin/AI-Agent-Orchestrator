import type { RunDisclosure } from '../../../../shared/contracts.js';
import { EffectivePermissionDisclosure } from '../permissions/EffectivePermissionDisclosure.js';
import { formatCommand } from './helpers.js';

export function RunDisclosureWarnings({ disclosure }: { disclosure: RunDisclosure }) {
  return (
    <>
      {disclosure.primaryWasDirty && (
        <div className="run-warning">
          The primary checkout already has changes. This run uses the disclosed location and does
          not silently overwrite them.
        </div>
      )}
      {disclosure.warnings.map((warning) => (
        <div className="run-warning" key={warning}>
          {warning}
        </div>
      ))}
    </>
  );
}

export function RunDisclosureDetails({
  disclosure,
  prompt,
}: {
  disclosure: RunDisclosure;
  prompt?: string;
}) {
  return (
    <dl className="run-disclosure-grid">
      <div>
        <dt>Provider</dt>
        <dd>{disclosure.provider}</dd>
      </div>
      <div>
        <dt>Runtime</dt>
        <dd>{disclosure.runtime.toUpperCase()}</dd>
      </div>
      <div className="wide">
        <dt>Executable and arguments</dt>
        <dd>
          <code>{formatCommand(disclosure.executable, disclosure.arguments)}</code>
        </dd>
      </div>
      <div className="wide">
        <dt>Working directory</dt>
        <dd>
          <code>{disclosure.cwd}</code>
        </dd>
      </div>
      <div>
        <dt>Branch</dt>
        <dd>{disclosure.branch ?? 'Current checkout'}</dd>
      </div>
      <div>
        <dt>Base commit</dt>
        <dd>
          <code>{disclosure.baseCommit?.slice(0, 12) ?? 'Not available'}</code>
        </dd>
      </div>
      {prompt !== undefined && (
        <div className="wide">
          <dt>Prompt</dt>
          <dd className="prompt-preview">{prompt}</dd>
        </div>
      )}
      <div className="wide">
        <dt>Permission enforcement</dt>
        <dd>
          <EffectivePermissionDisclosure profile={disclosure.permissionProfile} />
        </dd>
      </div>
      <div className="wide">
        <dt>Environment variable names</dt>
        <dd>
          {disclosure.environmentVariableNames.length
            ? disclosure.environmentVariableNames.join(', ')
            : 'No inherited variables'}
        </dd>
      </div>
      <div className="wide">
        <dt>Context attachments</dt>
        <dd>
          {disclosure.contextAttachments.length > 0 ? (
            <ul className="context-attachment-disclosure">
              {disclosure.contextAttachments.map((attachment) => (
                <li key={`${attachment.kind}:${attachment.path}`}>
                  <strong>{attachment.kind}</strong> <code>{attachment.path}</code>
                  <br />
                  SHA-256 <code>{attachment.sha256}</code>
                </li>
              ))}
            </ul>
          ) : (
            'None'
          )}
        </dd>
      </div>
      <div className="wide">
        <dt>Context manifest evidence</dt>
        <dd>
          {disclosure.contextManifestId !== null && disclosure.contextManifestId !== undefined ? (
            <>
              <code>{disclosure.contextManifestId}</code>
              <br />
              Resolver-supplied SHA-256{' '}
              <code>{disclosure.contextManifestDigest ?? 'Unavailable'}</code>
            </>
          ) : (
            'No context manifest'
          )}
        </dd>
      </div>
    </dl>
  );
}
