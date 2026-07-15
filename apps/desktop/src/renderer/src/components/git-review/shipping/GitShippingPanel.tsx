import { GitMerge, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import type { GitReviewView } from '../../../../../shared/git/contracts.js';
import type {
  GitShippingResultView,
  GitShippingStrategy,
} from '../../../../../shared/git/shipping-contracts.js';

export function GitShippingPanel({
  review,
  busy,
  result,
  onPrepare,
}: {
  review: GitReviewView;
  busy: boolean;
  result: GitShippingResultView | null;
  onPrepare: (strategy: GitShippingStrategy) => void;
}) {
  const [strategy, setStrategy] = useState<GitShippingStrategy>('fast-forward-only');
  const comparison = review.baseComparison;
  const ready =
    review.target.kind === 'agent-worktree' &&
    comparison !== undefined &&
    comparison.ahead > 0 &&
    !review.dirty &&
    !review.conflicted;
  const reason = review.dirty
    ? 'Commit or discard all agent worktree edits first.'
    : review.conflicted
      ? 'Resolve the agent worktree conflicts first.'
      : comparison?.ahead === 0
        ? 'There are no committed agent changes to deliver.'
        : 'Forgeboard will verify the source and primary checkout again before delivery.';

  return (
    <section className="git-shipping-panel" aria-labelledby="git-shipping-title">
      <span>
        <strong id="git-shipping-title">Deliver reviewed commits to primary</strong>
        <small>{reason}</small>
      </span>
      <label htmlFor="git-shipping-strategy">Delivery strategy</label>
      <select
        id="git-shipping-strategy"
        name="git-shipping-strategy"
        value={strategy}
        disabled={busy || !ready}
        onChange={(event) => setStrategy(event.target.value as GitShippingStrategy)}
      >
        <option value="fast-forward-only">Fast-forward only (safest)</option>
        <option value="cherry-pick">Cherry-pick reviewed commits</option>
      </select>
      <button
        className="button primary"
        type="button"
        disabled={busy || !ready}
        onClick={() => onPrepare(strategy)}
      >
        <GitMerge size={14} aria-hidden="true" /> Review delivery…
      </button>
      {result?.state === 'completed' && (
        <p className="git-shipping-result success" role="status">
          Delivered to primary at <code>{result.headAfter.slice(0, 12)}</code>.
        </p>
      )}
      {result?.state === 'conflicted' && (
        <p className="git-shipping-result conflict" role="alert">
          <TriangleAlert size={13} aria-hidden="true" /> Git stopped with conflicts in{' '}
          {result.conflictedPaths.join(', ')}. The primary checkout was left intact for review; no
          resolution was attempted.
        </p>
      )}
    </section>
  );
}
