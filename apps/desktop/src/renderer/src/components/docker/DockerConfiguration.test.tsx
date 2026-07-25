// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DockerReadiness, DockerReadinessInput } from '../../../../shared/docker/contracts.js';
import { DockerConfiguration } from './DockerConfiguration.js';

afterEach(cleanup);

describe('DockerConfiguration image picker', () => {
  it('syncs images and containers from the local daemon and autofills the default entrypoint', async () => {
    const listLocal = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          daemonAvailable: true,
          images: [{ reference: 'acme/agents:1' }],
          containers: [{ name: 'dev-box', image: 'acme/tools:2', state: 'running' }],
        },
      }),
    );
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        docker: { check: vi.fn(), pull: vi.fn(), listLocal },
        projects: { pickExecutable: vi.fn() },
      },
    });
    const onChange = vi.fn();
    render(
      <DockerConfiguration
        value={{ dockerExecutable: 'docker', dockerImage: '', dockerContainerExecutable: '' }}
        onChange={onChange}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    await screen.findByRole('option', { name: 'acme/agents:1' });
    expect(listLocal).toHaveBeenCalledWith({ dockerExecutable: 'docker' });
    expect(screen.getByRole('option', { name: 'node:22-bookworm — default' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'dev-box — acme/tools:2' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Container image'), {
      target: { value: 'node:22-bookworm' },
    });
    expect(onChange).toHaveBeenCalledWith({
      dockerExecutable: 'docker',
      dockerImage: 'node:22-bookworm',
      dockerContainerExecutable: '/usr/local/bin/node',
    });
  });

  it('keeps the picker usable with only the default image when Docker is unreachable', async () => {
    const listLocal = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          daemonAvailable: false,
          images: [],
          containers: [],
          reason: 'Docker is not running. Start it and sync again.',
        },
      }),
    );
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        docker: { check: vi.fn(), pull: vi.fn(), listLocal },
        projects: { pickExecutable: vi.fn() },
      },
    });
    render(
      <DockerConfiguration
        value={{ dockerExecutable: 'docker', dockerImage: '', dockerContainerExecutable: '' }}
        onChange={vi.fn()}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    await screen.findByText('Docker is not running. Start it and sync again.');
    expect(screen.getByRole('option', { name: 'node:22-bookworm — default' })).toBeTruthy();
  });
});

describe('DockerConfiguration readiness evidence', () => {
  it('does not emit a completed check after the configuration changed externally', async () => {
    const pending = deferred<DockerReadiness>();
    const check = vi.fn(() => pending.promise.then((value) => ({ ok: true as const, value })));
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        docker: { check, pull: vi.fn() },
        projects: { pickExecutable: vi.fn() },
      },
    });
    const onReadinessChange = vi.fn();
    const first = value('registry.example/agent:1');
    const view = render(
      <DockerConfiguration
        value={first}
        onChange={vi.fn()}
        onReadinessChange={onReadinessChange}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check Docker' }));
    expect(check).toHaveBeenCalledWith(request(first));
    view.rerender(
      <DockerConfiguration
        value={value('registry.example/agent:2')}
        onChange={vi.fn()}
        onReadinessChange={onReadinessChange}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );
    await act(async () => {
      pending.resolve(ready(request(first)));
      await pending.promise;
    });

    expect(screen.queryByText('Docker profile ready')).toBeNull();
    expect(onReadinessChange.mock.calls.some(([evidence]) => evidence !== null)).toBe(false);
  });
});

function value(image: string) {
  return {
    dockerExecutable: '/usr/local/bin/docker',
    dockerImage: image,
    dockerContainerExecutable: '/usr/local/bin/codex',
  };
}

function request(configuration: ReturnType<typeof value>): DockerReadinessInput {
  return {
    dockerExecutable: configuration.dockerExecutable,
    image: configuration.dockerImage,
    containerExecutable: configuration.dockerContainerExecutable,
  };
}

function ready(input: DockerReadinessInput): DockerReadiness {
  return {
    executable: input.dockerExecutable,
    image: input.image,
    containerExecutable: input.containerExecutable,
    executableAvailable: true,
    daemonAvailable: true,
    imageAvailable: true,
    imageCompatible: true,
    containerExecutableAvailable: true,
    available: true,
    status: 'ready',
    checkedAt: '2026-07-18T16:00:00.000Z',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
