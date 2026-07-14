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
});
