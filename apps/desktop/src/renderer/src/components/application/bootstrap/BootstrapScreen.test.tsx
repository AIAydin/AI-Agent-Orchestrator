// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BootstrapScreen } from './BootstrapScreen.js';

afterEach(cleanup);

describe('BootstrapScreen', () => {
  it('announces an honest loading state', () => {
    const { container } = render(<BootstrapScreen error={null} onRetry={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toBe('Opening Forgeboard…');
    expect(container.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('announces startup failure and offers a real retry without implying data loss', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <BootstrapScreen error="The local database could not be read." onRetry={onRetry} />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'The local database could not be read.',
    );
    expect(screen.getByText("Your projects and settings weren't changed.")).toBeTruthy();
    expect(container.querySelector('main')?.getAttribute('aria-busy')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
