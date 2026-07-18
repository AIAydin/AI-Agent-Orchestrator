import type { RunDisclosure } from '../../../../../shared/application/contracts.js';
import { EffectivePermissionDisclosure } from '../../permissions/EffectivePermissionDisclosure.js';
import { formatCommand } from '../model/helpers.js';

export function RunDisclosureWarnings({ disclosure }: { disclosure: RunDisclosure }) {
  return (
    <>
      {disclosure.primaryWasDirty && (
        <div className="run-warning">
          Your main project folder already has changes. This run works in its own copy, so those
          changes stay untouched.
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
        <dt>How it runs</dt>
        <dd>{disclosure.runtime.toUpperCase()}</dd>
      </div>
      <div className="wide">
        <dt>Command to run</dt>
        <dd>
          <code>{formatCommand(disclosure.executable, disclosure.arguments)}</code>
        </dd>
      </div>
      <div className="wide">
        <dt>Folder it runs in</dt>
        <dd>
          <code>{disclosure.cwd}</code>
        </dd>
      </div>
      <div>
        <dt>Branch</dt>
        <dd>{disclosure.branch ?? 'Your current files'}</dd>
      </div>
      <div>
        <dt>Starting commit</dt>
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
        <dt>Permission rules</dt>
        <dd>
          <EffectivePermissionDisclosure profile={disclosure.permissionProfile} />
        </dd>
      </div>
      <div className="wide">
        <dt>Environment variables (names only)</dt>
        <dd>
          {disclosure.environmentVariableNames.length
            ? disclosure.environmentVariableNames.join(', ')
            : 'None'}
        </dd>
      </div>
      <div className="wide">
        <dt>Attached context</dt>
        <dd>
          {disclosure.contextAttachments.length > 0 ? (
            <ul className="context-attachment-disclosure">
              {disclosure.contextAttachments.map((attachment) => (
                <li key={`${attachment.kind}:${attachment.path}`}>
                  <strong>{attachment.kind}</strong> <code>{attachment.path}</code>
                  <br />
                  Checksum (SHA-256) <code>{attachment.sha256}</code>
                </li>
              ))}
            </ul>
          ) : (
            'None'
          )}
        </dd>
      </div>
      <div className="wide">
        <dt>Context record</dt>
        <dd>
          {disclosure.contextManifestId !== null && disclosure.contextManifestId !== undefined ? (
            <>
              <code>{disclosure.contextManifestId}</code>
              <br />
              Checksum (SHA-256) <code>{disclosure.contextManifestDigest ?? 'Unavailable'}</code>
            </>
          ) : (
            'No context record'
          )}
        </dd>
      </div>
    </dl>
  );
}
