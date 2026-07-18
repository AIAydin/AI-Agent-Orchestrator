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
  deliveryReady,
  result,
  onPrepare,
}: {
  review: GitReviewView;
  busy: boolean;
  deliveryReady: boolean;
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
    !review.conflicted &&
    deliveryReady;
  const reason = review.dirty
    ? "Commit or discard all changes in the agent's workspace first."
    : review.conflicted
      ? "Fix the merge conflicts in the agent's workspace first."
      : comparison?.ahead === 0
        ? 'There are no committed agent changes to deliver yet.'
        : !deliveryReady
          ? 'Run every required check and approve the quality of the current changes first.'
          : "Forgeboard will double-check the agent's work and the primary branch before delivering.";

  return (
    <section className="git-shipping-panel" aria-labelledby="git-shipping-title">
      <span>
        <strong id="git-shipping-title">Deliver the reviewed changes to the primary branch</strong>
        <small>{reason}</small>
      </span>
      <label htmlFor="git-shipping-strategy">Delivery method</label>
      <select
        id="git-shipping-strategy"
        name="git-shipping-strategy"
        value={strategy}
        disabled={busy || !ready}
        onChange={(event) => setStrategy(event.target.value as GitShippingStrategy)}
      >
        <option value="fast-forward-only">Move the primary branch forward (safest)</option>
        <option value="cherry-pick">Copy the reviewed changes one by one</option>
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
          Delivered to the primary branch at <code>{result.headAfter.slice(0, 12)}</code>.
        </p>
      )}
      {result?.state === 'conflicted' && (
        <p className="git-shipping-result conflict" role="alert">
          <TriangleAlert size={13} aria-hidden="true" /> Git stopped because of conflicting changes
          in {result.conflictedPaths.join(', ')}. The primary branch was left untouched — nothing
          there was changed.
        </p>
      )}
    </section>
  );
}
