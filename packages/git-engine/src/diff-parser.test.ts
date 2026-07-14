import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff, patchSha256, selectDiffHunks } from './diff-parser.js';

const TWO_HUNK_DIFF = `diff --git a/example.txt b/example.txt
index 1234567..89abcde 100644
--- a/example.txt
+++ b/example.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,3 +10,4 @@ later
 ten
+ten-and-a-half
 eleven
 twelve
`;

const IDENTICAL_HUNKS_IN_DIFFERENT_FILES = `diff --git a/alpha.txt b/alpha.txt
index 1234567..89abcde 100644
--- a/alpha.txt
+++ b/alpha.txt
@@ -1 +1 @@
-old
+new
diff --git a/beta.txt b/beta.txt
index 1234567..89abcde 100644
--- a/beta.txt
+++ b/beta.txt
@@ -1 +1 @@
-old
+new
`;

describe('unified diff parser', () => {
  it('returns stable, individually selectable hunks and line counts', () => {
    const parsed = parseUnifiedDiff(TWO_HUNK_DIFF);

    expect(parsed).toMatchObject({ additions: 2, deletions: 1 });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.hunks).toHaveLength(2);
    expect(parsed.files[0]?.hunks[0]?.lines[1]).toMatchObject({
      kind: 'deletion',
      oldLine: 2,
      newLine: null,
    });

    const selected = selectDiffHunks(parsed, [parsed.files[0]?.hunks[1]?.id ?? '']);
    expect(selected).toContain('diff --git a/example.txt b/example.txt');
    expect(selected).toContain('ten-and-a-half');
    expect(selected).not.toContain('-two');
    expect(patchSha256(selected)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects unknown and duplicate hunk selections', () => {
    const parsed = parseUnifiedDiff(TWO_HUNK_DIFF);
    const id = parsed.files[0]?.hunks[0]?.id ?? '';
    expect(() => selectDiffHunks(parsed, [id, id])).toThrow(/Duplicate/u);
    expect(() => selectDiffHunks(parsed, ['not-a-hunk'])).toThrow(/do not exist/u);
  });

  it('scopes hunk identifiers to their file when patch bodies are identical', () => {
    const parsed = parseUnifiedDiff(IDENTICAL_HUNKS_IN_DIFFERENT_FILES);
    const alphaId = parsed.files[0]?.hunks[0]?.id ?? '';
    const betaId = parsed.files[1]?.hunks[0]?.id ?? '';

    expect(alphaId).not.toBe(betaId);
    expect(parseUnifiedDiff(IDENTICAL_HUNKS_IN_DIFFERENT_FILES).files[1]?.hunks[0]?.id).toBe(
      betaId,
    );
    const selected = selectDiffHunks(parsed, [betaId]);
    expect(selected).toContain('diff --git a/beta.txt b/beta.txt');
    expect(selected).not.toContain('diff --git a/alpha.txt b/alpha.txt');
  });
});
