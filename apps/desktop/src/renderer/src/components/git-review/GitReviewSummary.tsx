import { CircleAlert, GitBranch, GitCompareArrows, UserRoundCheck, UserRoundX } from 'lucide-react';

import type { GitReviewView } from '../../../../shared/git/contracts.js';

function identitySource(source: GitReviewView['identity']['nameSource']): string {
  if (source === 'git-config') return 'Git config';
  if (source === 'settings') return 'Forgeboard settings';
  return 'not configured';
}

export function GitReviewSummary({ review }: { review: GitReviewView }) {
  const branch = review.detached ? 'Detached HEAD' : (review.branch ?? 'Unborn branch');
  const identity = review.identity;

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
          <small>{review.upstream ?? 'No upstream'}</small>
          <strong>
            {review.ahead} ahead · {review.behind} behind
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
          <small>Working tree</small>
          <strong>
            {review.conflicted ? 'Conflicts require attention' : review.dirty ? 'Changed' : 'Clean'}
          </strong>
        </span>
      </div>
      <div className={identity.ready ? '' : 'danger'}>
        {identity.ready ? (
          <UserRoundCheck size={15} aria-hidden="true" />
        ) : (
          <UserRoundX size={15} aria-hidden="true" />
        )}
        <span>
          <small>Commit identity · {identitySource(identity.nameSource)}</small>
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
