import type {
  CollaborationCommentMetadata,
  CollaborationMetadataSnapshot,
} from '../../../../../../shared/collaboration/index.js';
import { jsonValuesEqual } from './three-way.js';

/** Clears quarantine only when a correlated acknowledged candidate contains the exact value. */
export function rejectedCommentsAfterAcknowledgement(
  rejected: readonly CollaborationCommentMetadata[],
  candidate: Readonly<CollaborationMetadataSnapshot['comments']>,
): CollaborationCommentMetadata[] {
  return rejected.filter((comment) => !jsonValuesEqual(candidate[comment.id], comment));
}
