// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DockerConfiguration } from '../../docker/DockerConfiguration.js';

afterEach(cleanup);

describe('integration action UI presence', () => {
  it('renders Docker browse, readiness, and reviewed image actions', () => {
    render(
      <DockerConfiguration
        value={{
          dockerExecutable: 'docker',
          dockerImage: 'example/agent:latest',
          dockerContainerExecutable: '/usr/local/bin/agent',
        }}
        onChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Browse' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Docker' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pull image…' })).toBeTruthy();
    expect(screen.getByText('Docker profile not checked yet')).toBeTruthy();
  });
});
