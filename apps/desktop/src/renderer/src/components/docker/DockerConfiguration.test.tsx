// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DockerReadiness, DockerReadinessInput } from '../../../../shared/docker/contracts.js';
import { DockerConfiguration } from './DockerConfiguration.js';

afterEach(cleanup);

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
