// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
} from '../../../shared/contracts.js';
import type { DockerReadiness } from '../../../shared/docker-contracts.js';
import { SetupWizard } from './SetupWizard.js';

const settings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'test-agent',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/forgeboard-worktrees',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH'],
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: 'ws://127.0.0.1:1234',
});

const agents: AgentDetection[] = [
  {
    id: 'test-agent',
    label: 'Deterministic test agent',
    installed: true,
    executable: '/tmp/test-agent',
    version: '0.1.0',
    providerDisclosure: 'Local fixture.',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    installed: true,
    executable: '/usr/local/bin/codex',
    version: '1.0.0',
    providerDisclosure: 'Uses the local CLI account.',
  },
];

const readyDocker: DockerReadiness = {
  executable: '/usr/local/bin/docker',
  image: 'registry.example/agent:1',
  containerExecutable: '/usr/local/bin/codex',
  executableAvailable: true,
  daemonAvailable: true,
  imageAvailable: true,
  imageCompatible: true,
  containerExecutableAvailable: true,
  available: true,
  status: 'ready',
  checkedAt: '2026-07-14T16:00:00.000Z',
  daemonVersion: '27.5.1',
  imageId: 'sha256:abc123',
  agentVersion: 'codex 1.2.3',
};

const dockerCheck = vi.fn(() => Promise.resolve({ ok: true as const, value: readyDocker }));
const dockerPull = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: { outcome: 'pulled' as const, readiness: readyDocker },
  }),
);

beforeEach(() => {
  dockerCheck.mockReset();
  dockerCheck.mockResolvedValue({ ok: true, value: readyDocker });
  dockerPull.mockReset();
  dockerPull.mockResolvedValue({
    ok: true,
    value: { outcome: 'pulled', readiness: readyDocker },
  });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      docker: { check: dockerCheck, pull: dockerPull },
      projects: {
        pickExecutable: vi.fn(() => Promise.resolve({ ok: true, value: null })),
        pickParent: vi.fn(() => Promise.resolve({ ok: true, value: null })),
      },
    },
  });
});

afterEach(cleanup);

describe('SetupWizard', () => {
  it('completes agent, Docker, preview, and worktree setup entirely through controls', async () => {
    const onComplete = vi.fn<(settings: AppSettings) => Promise<void>>(() => Promise.resolve());
    render(
      <SetupWizard
        settings={settings}
        agents={agents}
        onComplete={onComplete}
        onSkip={() => Promise.resolve()}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Set up Forgeboard/ }));
    fireEvent.click(screen.getByRole('radio', { name: /OpenAI Codex CLI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    fireEvent.click(screen.getByRole('radio', { name: /Docker isolated/ }));
    fireEvent.change(screen.getByLabelText('Container image'), {
      target: { value: readyDocker.image },
    });
    fireEvent.change(screen.getByLabelText('Agent executable inside image'), {
      target: { value: readyDocker.containerExecutable },
    });
    fireEvent.click(screen.getByRole('button', { name: /Check Docker/ }));
    await screen.findByText('Docker profile ready');
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    fireEvent.change(screen.getByLabelText('Development server executable'), {
      target: { value: 'pnpm' },
    });
    fireEvent.change(screen.getByLabelText('Development server arguments, one per line'), {
      target: { value: 'dev\n--host' },
    });
    expect(screen.queryByLabelText('Test command executable')).toBeNull();
    expect(screen.queryByLabelText('Cleanup policy')).toBeNull();
    fireEvent.change(screen.getByLabelText('Branch prefix'), {
      target: { value: 'workshop/' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Open Forgeboard/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
      defaultAgent: 'codex',
      defaultPermissionProfile: 'docker-isolated',
      dockerEnabled: true,
      branchPrefix: 'workshop/',
      developmentCommand: { executable: 'pnpm', arguments: ['dev', '--host'] },
      dockerImage: readyDocker.image,
      dockerContainerExecutable: readyDocker.containerExecutable,
    });
  });

  it('does not call Docker ready until the exact image and executable pass a main check', async () => {
    dockerCheck.mockResolvedValueOnce({
      ok: true,
      value: {
        ...readyDocker,
        imageAvailable: false,
        imageCompatible: false,
        containerExecutableAvailable: false,
        available: false,
        status: 'image-missing',
        reason: 'The image is not available locally.',
      },
    });
    render(
      <SetupWizard
        settings={settings}
        agents={agents}
        onComplete={() => Promise.resolve()}
        onSkip={() => Promise.resolve()}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Set up Forgeboard/ }));
    fireEvent.click(screen.getByRole('radio', { name: /OpenAI Codex CLI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Docker isolated/ }));
    fireEvent.change(screen.getByLabelText('Container image'), {
      target: { value: readyDocker.image },
    });
    fireEvent.change(screen.getByLabelText('Agent executable inside image'), {
      target: { value: readyDocker.containerExecutable },
    });

    const continueButton = screen.getByRole('button', { name: /Continue/ });
    expect(continueButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Check Docker/ }));
    await screen.findByText('Image is not stored locally');
    expect(continueButton.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Pull image/ }));
    await screen.findByText('Docker profile ready');
    expect(dockerPull).toHaveBeenCalledWith({
      dockerExecutable: 'docker',
      image: readyDocker.image,
      containerExecutable: readyDocker.containerExecutable,
    });
    expect(continueButton.hasAttribute('disabled')).toBe(false);
  });

  it('offers an immediate safe-default path', async () => {
    const onSkip = vi.fn<() => Promise<void>>(() => Promise.resolve());
    render(
      <SetupWizard
        settings={settings}
        agents={agents}
        onComplete={() => Promise.resolve()}
        onSkip={onSkip}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    expect(screen.getByText('Welcome', { selector: 'li' }).getAttribute('aria-current')).toBe(
      'step',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use safe defaults' }));
    await waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
  });
});
