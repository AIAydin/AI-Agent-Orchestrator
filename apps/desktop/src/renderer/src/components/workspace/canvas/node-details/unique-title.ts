/**
 * Node-title de-duplication for inline renames.
 *
 * The canvas keeps node titles human-distinguishable: two nodes should not end up with the exact
 * same visible name. When a rename would collide with another node's title, a numeric suffix is
 * appended (" (2)", " (3)", …) until the title is unique. The node being renamed is excluded from
 * the comparison so re-committing an unchanged title is a no-op rather than growing a suffix.
 */
export interface UniqueTitleRosterEntry {
  readonly id: string;
  readonly title: string;
}

/**
 * Resolve `desired` to a title not already taken by another node in `roster`.
 * Returns the trimmed desired title when it is free, otherwise the first free " (n)" variant.
 * A blank desired title yields an empty string so callers can treat it as "no change".
 */
export function uniqueNodeTitle(
  desired: string,
  nodeId: string,
  roster: readonly UniqueTitleRosterEntry[],
): string {
  const trimmed = desired.trim();
  if (trimmed === '') return '';
  const taken = new Set(roster.filter((entry) => entry.id !== nodeId).map((entry) => entry.title));
  if (!taken.has(trimmed)) return trimmed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${trimmed} (${String(suffix)})`;
    if (!taken.has(candidate)) return candidate;
  }
}
