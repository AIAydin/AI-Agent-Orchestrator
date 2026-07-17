// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { PreviewSessionSnapshot } from '../../../../../shared/application/contracts.js';
import { PreviewConsole } from './PreviewConsole.js';

afterEach(cleanup);

describe('PreviewConsole', () => {
  it('bounds rendered output to a tail and discloses browser-console truncation and errors', () => {
    const session: PreviewSessionSnapshot = {
      id: '024b6a04-8a03-4d24-a16f-4baf20ddb3f5',
      status: 'failed',
      startedAt: '2026-07-14T16:00:00.000Z',
      readyAt: null,
      stoppedAt: '2026-07-14T16:00:01.000Z',
      failure: 'Server exited.',
      trustedHosts: ['127.0.0.1'],
      processes: [
        {
          id: 'server',
          pid: null,
          cwd: '.',
          port: null,
          previewUrl: null,
          status: 'exited',
          exitCode: 1,
          exitSignal: null,
          retainedLogBytes: 160_000,
          logs: [
            {
              sequence: 1,
              timestamp: '2026-07-14T16:00:00.000Z',
              stream: 'stderr',
              data: `old-marker-${'x'.repeat(150_000)}-new-tail`,
            },
          ],
        },
      ],
    };

    render(
      <PreviewConsole
        session={session}
        browserConsole={{
          entries: [
            {
              sequence: 1,
              capturedAt: '2026-07-14T16:00:00.000Z',
              level: 'error',
              message: 'Browser exploded',
              source: null,
              line: null,
            },
          ],
          truncated: true,
          retainedBytes: 2048,
          disclosure:
            'Console output is captured in memory only, bounded to 500 entries and 256 KiB, and may contain application data.',
        }}
      />,
    );

    const output = screen.getByLabelText('Preview console output').textContent ?? '';
    expect(output.length).toBeLessThanOrEqual(128 * 1024);
    expect(output).not.toContain('old-marker');
    expect(output).toContain('new-tail');
    expect(output).toContain('[browser:error] Browser exploded');
    expect(screen.getByRole('status').textContent).toContain('Older output is hidden');
    expect(screen.getByText(/1 browser errors/u)).toBeTruthy();
  });
});
