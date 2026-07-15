import { parseUnifiedDiff, type ParsedDiff, type RepositoryService } from '@forgeboard/git-engine';

import {
  GitAgentBaseComparisonViewSchema,
  type GitAgentBaseComparisonView,
  type GitDiffView,
} from '../../shared/git/contracts.js';

const MAX_COMMIT_IDS_PER_SIDE = 256;
const COMMIT_ID_OUTPUT_LIMIT = 64 * 1_024;
const DIFF_OUTPUT_LIMIT = 6 * 1_024 * 1_024;

export interface AgentBaseComparisonInput {
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

/** Builds a bounded, immutable-commit comparison without accepting renderer-provided refs. */
export async function createAgentBaseComparison(
  repositories: RepositoryService,
  input: AgentBaseComparisonInput,
): Promise<GitAgentBaseComparisonView> {
  const [baseCommit, headCommit] = await Promise.all([
    repositories.resolveRef(input.repositoryRoot, input.baseCommit),
    repositories.resolveRef(input.repositoryRoot, input.headCommit),
  ]);
  if (baseCommit !== input.baseCommit || headCommit !== input.headCommit) {
    throw new Error('The agent comparison commit binding changed before Git comparison.');
  }

  const [aheadBehind, aheadResult, behindResult, diffResult] = await Promise.all([
    repositories.aheadBehind(input.repositoryRoot, baseCommit, headCommit),
    repositories.git.run(
      [
        '-C',
        input.repositoryRoot,
        'rev-list',
        '--reverse',
        `--max-count=${MAX_COMMIT_IDS_PER_SIDE + 1}`,
        `${baseCommit}..${headCommit}`,
      ],
      { maxOutputBytes: COMMIT_ID_OUTPUT_LIMIT },
    ),
    repositories.git.run(
      [
        '-C',
        input.repositoryRoot,
        'rev-list',
        '--reverse',
        `--max-count=${MAX_COMMIT_IDS_PER_SIDE + 1}`,
        `${headCommit}..${baseCommit}`,
      ],
      { maxOutputBytes: COMMIT_ID_OUTPUT_LIMIT },
    ),
    repositories.git.runGuarded(
      [
        '-C',
        input.repositoryRoot,
        '-c',
        'core.quotePath=true',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--binary',
        '--find-renames',
        '--find-copies',
        '--unified=3',
        baseCommit,
        headCommit,
        '--',
      ],
      { repositoryPath: input.repositoryRoot, operation: 'object-inspection' },
      { maxOutputBytes: DIFF_OUTPUT_LIMIT },
    ),
  ]);
  const aheadIds = parseCommitIds(aheadResult.stdout);
  const behindIds = parseCommitIds(behindResult.stdout);
  const commitIdsTruncated =
    aheadIds.length > MAX_COMMIT_IDS_PER_SIDE || behindIds.length > MAX_COMMIT_IDS_PER_SIDE;
  return GitAgentBaseComparisonViewSchema.parse({
    baseCommit,
    headCommit,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    commitCount: aheadBehind.ahead + aheadBehind.behind,
    commits: [
      ...aheadIds.slice(0, MAX_COMMIT_IDS_PER_SIDE).map((oid) => ({ oid, relation: 'ahead' })),
      ...behindIds.slice(0, MAX_COMMIT_IDS_PER_SIDE).map((oid) => ({ oid, relation: 'behind' })),
    ],
    commitIdsTruncated,
    diff: diffView(parseUnifiedDiff(diffResult.stdout)),
  });
}

function parseCommitIds(output: string): string[] {
  const commits = output.split(/\r?\n/u).filter((line) => line !== '');
  if (commits.some((commit) => !/^[a-f0-9]{40,64}$/u.test(commit))) {
    throw new Error('Git returned an invalid commit identifier for the agent comparison.');
  }
  return commits;
}

function diffView(diff: ParsedDiff): GitDiffView {
  return {
    files: diff.files.map((file) => ({
      oldPath: file.oldPath,
      newPath: file.newPath,
      status: file.status,
      binary: file.binary,
      hunks: file.hunks.map(({ id, header, oldStart, oldLines, newStart, newLines, lines }) => ({
        id,
        header,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: lines.map((line) => ({ ...line })),
      })),
    })),
    additions: diff.additions,
    deletions: diff.deletions,
  };
}
