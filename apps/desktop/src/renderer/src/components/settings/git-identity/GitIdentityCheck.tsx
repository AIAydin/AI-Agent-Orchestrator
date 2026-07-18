import { useEffect, useRef, useState } from 'react';

import type { Project } from '../../../../../shared/application/contracts.js';
import type {
  GitIdentityCheckInput,
  GitIdentityCheckResult,
} from '../../../../../shared/git/identity/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { gitIdentityCheckRequest, sameGitIdentityRequest } from './request.js';

interface GitIdentityCheckProps {
  readonly name: string;
  readonly email: string;
  readonly activeProject: Project | null;
  readonly busy: boolean;
  readonly perform: (operation: () => Promise<void>) => Promise<void>;
}

type CheckState =
  | { readonly request: GitIdentityCheckInput; readonly result: GitIdentityCheckResult }
  | { readonly request: GitIdentityCheckInput; readonly result: null };

export function GitIdentityCheck({
  name,
  email,
  activeProject,
  busy,
  perform,
}: GitIdentityCheckProps) {
  const request = gitIdentityCheckRequest(name, email, activeProject);
  const requestRef = useRef(request);
  requestRef.current = request;
  const [state, setState] = useState<CheckState | null>(null);
  const currentState =
    state !== null && sameGitIdentityRequest(state.request, request) ? state : null;

  useEffect(() => {
    setState(null);
  }, [name, email, activeProject?.id]);

  async function check(): Promise<void> {
    if (request === null) return;
    const checkedRequest = request;
    setState(null);
    let completed = false;
    await perform(async () => {
      const result = unwrap(await window.forgeboard.git.identity.check(checkedRequest));
      completed = true;
      if (
        sameGitIdentityRequest(result.request, checkedRequest) &&
        sameGitIdentityRequest(requestRef.current, checkedRequest)
      ) {
        setState({ request: checkedRequest, result });
      }
    });
    if (!completed && sameGitIdentityRequest(requestRef.current, checkedRequest)) {
      setState({ request: checkedRequest, result: null });
    }
  }

  const partial = (name.trim() === '') !== (email.trim() === '');
  return (
    <div className="settings-inline-actions">
      <button
        type="button"
        className="button secondary"
        disabled={busy || request === null}
        onClick={() => void check()}
      >
        Check Git identity
      </button>
      {partial ? (
        <small role="status">Enter both a Git identity name and email, or leave both blank.</small>
      ) : request === null ? (
        <small role="status">Open a project to check its repository Git identity.</small>
      ) : currentState === null ? (
        <small>
          {request.source === 'settings'
            ? 'Checks these exact unsaved values locally with Git.'
            : 'Reads the selected repository locally. No remote is contacted.'}
        </small>
      ) : currentState.result === null ? (
        <p className="recovery-guidance warning" role="status">
          The Git identity check did not complete. Review the error and try again.
        </p>
      ) : currentState.result.identity.ready ? (
        <dl className="settings-summary" aria-label="Effective Git identity">
          <div>
            <dt>Name</dt>
            <dd>{currentState.result.identity.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{currentState.result.identity.email}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {currentState.result.request.source === 'settings'
                ? 'Current Settings draft'
                : 'Selected repository Git configuration'}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="recovery-guidance warning" role="status">
          No complete Git identity is configured. Enter both fields above or configure user.name and
          user.email for this repository.
        </p>
      )}
    </div>
  );
}
