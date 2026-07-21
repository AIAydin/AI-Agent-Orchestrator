import {
  CircleAlert,
  FileDiff,
  GitBranch,
  GitCompareArrows,
  UserRoundCheck,
  UserRoundX,
} from 'lucide-react';

import type { GitReviewView } from '../../../../shared/git/contracts.js';
import { WorkspaceTooltip } from '../workspace/shell/tooltips/WorkspaceTooltip.js';
import { workingTreeDiffStats } from './git-review-model.js';

function identitySource(source: GitReviewView['identity']['nameSource']): string {
  if (source === 'git-config') return 'Git config';
  if (source === 'settings') return 'Forgeboard settings';
  return 'not set up';
}

export function GitReviewSummary({ review }: { review: GitReviewView }) {
  const branch = review.detached ? 'Not on a branch' : (review.branch ?? 'No commits yet');
  const identity = review.identity;
  const diffStats = workingTreeDiffStats(review);

  return (
    <section className="git-review-summary" aria-label="Repository status">
      <div>
        <GitBranch size={15} aria-hidden="true" />
        <span>
          <small>Branch</small>
          <strong>{branch}</strong>
        </span>
      </div>
      <div>
        <GitCompareArrows size={15} aria-hidden="true" />
        <span>
          <small>{review.upstream ?? 'Not linked to a remote branch'}</small>
          <strong>
            {review.ahead} {review.ahead === 1 ? 'commit' : 'commits'} ahead · {review.behind}{' '}
            {review.behind === 1 ? 'commit' : 'commits'} behind
          </strong>
        </span>
      </div>
      <div className={review.conflicted ? 'danger' : ''}>
        {review.conflicted ? (
          <CircleAlert size={15} aria-hidden="true" />
        ) : (
          <GitBranch size={15} aria-hidden="true" />
        )}
        <span>
          <small>Local edits</small>
          <strong>
            {review.conflicted ? 'Conflicts to fix' : review.dirty ? 'Changed' : 'None'}
          </strong>
        </span>
      </div>
      <WorkspaceTooltip content="Only counts line changes in files Git already tracks. New and binary files aren't counted.">
        <div tabIndex={0} role="group" aria-label="Tracked file line changes">
          <FileDiff size={15} aria-hidden="true" />
          <span>
            <small>Changes to review · tracked files</small>
            <strong>
              {diffStats.files} {diffStats.files === 1 ? 'file' : 'files'} · +{diffStats.additions}{' '}
              −{diffStats.deletions}
            </strong>
          </span>
        </div>
      </WorkspaceTooltip>
      <div className={identity.ready ? '' : 'danger'}>
        {identity.ready ? (
          <UserRoundCheck size={15} aria-hidden="true" />
        ) : (
          <UserRoundX size={15} aria-hidden="true" />
        )}
        <span>
          <small>Commit author · {identitySource(identity.nameSource)}</small>
          <strong>
            {identity.ready
              ? `${identity.name} <${identity.email}>`
              : 'Set name and email in Settings'}
          </strong>
        </span>
      </div>
    </section>
  );
}
