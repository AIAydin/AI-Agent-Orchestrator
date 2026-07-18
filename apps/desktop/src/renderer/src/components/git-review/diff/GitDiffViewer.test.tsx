// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitDiffLineView } from '../../../../../shared/git/contracts.js';
import type { GitDiffDisplayFile } from '../git-review-model.js';
import { buildSplitRows } from './GitDiffRows.js';
import { GitDiffViewer } from './GitDiffViewer.js';

afterEach(cleanup);

describe('GitDiffViewer', () => {
  it('switches between unified and split layouts and reveals whitespace without changing content', () => {
    renderViewer();

    expect(
      screen.getByRole('table', { name: 'Changes in src/example.ts (one column)' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'One column' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByLabelText('1 line added and 1 line removed in src/example.ts')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show spaces and tabs' }));
    const unifiedCodes = [
      ...screen
        .getByRole('table', { name: 'Changes in src/example.ts (one column)' })
        .querySelectorAll('code'),
    ];
    const unifiedOldLine = unifiedCodes.find((code) => code.textContent === '→\told·line·');
    expect(unifiedOldLine?.getAttribute('aria-label')).toBe('\told line ');

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    const splitTable = screen.getByRole('table', {
      name: 'Changes in src/example.ts (side by side)',
    });
    expect(screen.getByRole('button', { name: 'Side by side' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const splitCodes = [...splitTable.querySelectorAll('code')];
    const oldLine = splitCodes.find((code) => code.textContent === '→\told·line·');
    const newLine = splitCodes.find((code) => code.textContent === 'new·line·');
    expect(oldLine).toBeTruthy();
    expect(newLine).toBeTruthy();
    expect(oldLine?.closest('tr')).toBe(newLine?.closest('tr'));
  });

  it('pairs replacement blocks without dropping unmatched or context lines', () => {
    const lines = [
      { kind: 'deletion', content: 'old one', oldLine: 1, newLine: null },
      { kind: 'deletion', content: 'old two', oldLine: 2, newLine: null },
      { kind: 'addition', content: 'new one', oldLine: null, newLine: 1 },
      { kind: 'context', content: 'shared', oldLine: 3, newLine: 2 },
    ] satisfies readonly GitDiffLineView[];

    const rows = buildSplitRows(lines);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ oldLine: lines[0], newLine: lines[2] });
    expect(rows[1]).toEqual({ oldLine: lines[1], newLine: null });
    expect(rows[2]).toEqual({ oldLine: lines[3], newLine: lines[3] });
  });

  it('exposes previous and next navigation only within the authoritative file bounds', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const rendered = renderViewer({ index: 0, count: 2, onPrevious, onNext });

    expect(screen.getByText('File 1 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous changed file' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next changed file' }));
    expect(onNext).toHaveBeenCalledTimes(1);

    rendered.rerender(viewer({ index: 1, count: 2, onPrevious, onNext }));
    expect(screen.getByText('File 2 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next changed file' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous changed file' }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('uses controlled node preferences and reports display-only changes', () => {
    const onDisplayPreferencesChange = vi.fn();
    render(
      <GitDiffViewer
        file={file}
        busy={false}
        displayPreferences={{ viewMode: 'split', showWhitespace: true }}
        onDisplayPreferencesChange={onDisplayPreferencesChange}
        onStageHunk={() => undefined}
        onUnstageHunk={() => undefined}
        onPrepareDiscard={() => undefined}
      />,
    );

    expect(
      screen.getByRole('table', { name: 'Changes in src/example.ts (side by side)' }),
    ).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Show spaces and tabs' })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'One column' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show spaces and tabs' }));

    expect(onDisplayPreferencesChange).toHaveBeenNthCalledWith(1, {
      viewMode: 'unified',
      showWhitespace: true,
    });
    expect(onDisplayPreferencesChange).toHaveBeenNthCalledWith(2, {
      viewMode: 'split',
      showWhitespace: false,
    });
  });

  it('seeds local display controls from a locked node without persisting changes', () => {
    render(
      <GitDiffViewer
        file={file}
        busy={false}
        displayPreferences={{ viewMode: 'split', showWhitespace: true }}
        onStageHunk={() => undefined}
        onUnstageHunk={() => undefined}
        onPrepareDiscard={() => undefined}
      />,
    );

    expect(
      screen.getByRole('table', { name: 'Changes in src/example.ts (side by side)' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'One column' }));
    expect(
      screen.getByRole('table', { name: 'Changes in src/example.ts (one column)' }),
    ).toBeTruthy();
  });

  it('keeps the latest controlled preferences when persistence becomes read-only', async () => {
    const onDisplayPreferencesChange = vi.fn();
    const rendered = render(
      <GitDiffViewer
        file={file}
        busy={false}
        displayPreferences={{ viewMode: 'split', showWhitespace: true }}
        onDisplayPreferencesChange={onDisplayPreferencesChange}
        onStageHunk={() => undefined}
        onUnstageHunk={() => undefined}
        onPrepareDiscard={() => undefined}
      />,
    );

    rendered.rerender(
      <GitDiffViewer
        file={file}
        busy={false}
        displayPreferences={{ viewMode: 'unified', showWhitespace: false }}
        onDisplayPreferencesChange={onDisplayPreferencesChange}
        onStageHunk={() => undefined}
        onUnstageHunk={() => undefined}
        onPrepareDiscard={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'Changes in src/example.ts (one column)' }),
      ).toBeTruthy(),
    );

    rendered.rerender(
      <GitDiffViewer
        file={file}
        busy={false}
        displayPreferences={{ viewMode: 'unified', showWhitespace: false }}
        onStageHunk={() => undefined}
        onUnstageHunk={() => undefined}
        onPrepareDiscard={() => undefined}
      />,
    );
    expect(
      screen.getByRole('table', { name: 'Changes in src/example.ts (one column)' }),
    ).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Show spaces and tabs' })).toHaveProperty(
      'checked',
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(
      screen.getByRole('table', { name: 'Changes in src/example.ts (side by side)' }),
    ).toBeTruthy();
  });
});

function renderViewer(navigation?: {
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return render(viewer(navigation));
}

function viewer(navigation?: {
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <GitDiffViewer
      file={file}
      busy={false}
      {...(navigation === undefined ? {} : { navigation })}
      onStageHunk={() => undefined}
      onUnstageHunk={() => undefined}
      onPrepareDiscard={() => undefined}
    />
  );
}

const file: GitDiffDisplayFile = {
  area: 'unstaged',
  path: 'src/example.ts',
  diff: {
    oldPath: 'src/example.ts',
    newPath: 'src/example.ts',
    status: 'modified',
    binary: false,
    hunks: [
      {
        id: 'a'.repeat(20),
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'deletion', content: '\told line ', oldLine: 1, newLine: null },
          { kind: 'addition', content: 'new line ', oldLine: null, newLine: 1 },
        ],
      },
    ],
  },
};
