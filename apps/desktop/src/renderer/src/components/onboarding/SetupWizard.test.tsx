// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
  type Project,
} from '../../../../shared/application/contracts.js';
import type { DockerReadiness } from '../../../../shared/docker/contracts.js';
import type { AgentReadinessResult } from '../../../../shared/readiness/contracts.js';
import type { ProviderConnectionStatus } from '../../../../shared/provider-connections/index.js';
import type {
  CommandReadinessRequest,
  CommandReadinessResult,
} from '../../../../shared/command-readiness/contracts.js';
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

const suggestionProject: Project = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Known web app',
  path: '/projects/known-web-app',
  openedAt: '2026-07-15T17:00:00.000Z',
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'pnpm',
    frameworks: ['Vite'],
    scripts: { dev: 'vite', test: 'vitest' },
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};

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
const pickExecutable = vi.fn(() =>
  Promise.resolve({ ok: true as const, value: null as string | null }),
);
const commandCheck = vi.fn((input: CommandReadinessRequest) =>
  Promise.resolve({ ok: true as const, value: readyCommand(input) }),
);
const providerGet = vi.fn(
  ({
    providerId,
  }: {
    providerId: 'codex' | 'claude';
  }): Promise<{ ok: true; value: ProviderConnectionStatus }> =>
    Promise.resolve({
      ok: true as const,
      value: {
        schemaVersion: 1 as const,
        providerId,
        state: 'connected' as const,
        checkedAt: '2026-07-17T12:00:00.000Z',
        reason: null,
      },
    }),
);

function readyCommand(input: CommandReadinessRequest): CommandReadinessResult {
  const projectValidated = input.projectId !== null;
  const partial =
    !projectValidated &&
    ['npm', 'pnpm', 'yarn', 'bun'].includes(input.command.executable) &&
    input.command.arguments[0] === 'run';
  return {
    schemaVersion: 1,
    request: input,
    state: partial ? 'ready-without-project' : 'ready',
    ready: true,
    validationScope: projectValidated ? 'project' : 'executable',
    resolvedExecutable: `/resolved/${input.command.executable.split('/').at(-1) ?? 'command'}`,
    projectName: projectValidated ? 'Example project' : null,
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason: null,
    warning: partial ? 'Open a project to validate the selected package script.' : null,
  };
}

beforeEach(() => {
  dockerCheck.mockReset();
  dockerCheck.mockResolvedValue({ ok: true, value: readyDocker });
  dockerPull.mockReset();
  dockerPull.mockResolvedValue({
    ok: true,
    value: { outcome: 'pulled', readiness: readyDocker },
  });
  pickExecutable.mockReset();
  pickExecutable.mockResolvedValue({ ok: true, value: null });
  commandCheck.mockReset();
  commandCheck.mockImplementation((input) =>
    Promise.resolve({ ok: true, value: readyCommand(input) }),
  );
  providerGet.mockReset();
  providerGet.mockImplementation(({ providerId }) =>
    Promise.resolve({
      ok: true,
      value: {
        schemaVersion: 1,
        providerId,
        state: 'connected',
        checkedAt: '2026-07-17T12:00:00.000Z',
        reason: null,
      },
    }),
  );
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      docker: { check: dockerCheck, pull: dockerPull },
      projects: {
        pickExecutable,
        pickParent: vi.fn(() => Promise.resolve({ ok: true, value: null })),
        pickReferences: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      },
      commands: { checkReadiness: commandCheck },
      agents: {
        connections: {
          get: providerGet,
          prepare: vi.fn(),
          confirm: vi.fn(),
          cancel: vi.fn(),
        },
      },
    },
  });
});

afterEach(cleanup);

describe('SetupWizard', () => {
  it('guides Codex onboarding through official provider sign-in with advanced CLI controls folded', async () => {
    providerGet.mockImplementation(({ providerId }) =>
      Promise.resolve({
        ok: true,
        value: {
          schemaVersion: 1,
          providerId,
          state: 'disconnected',
          checkedAt: null,
          reason: 'Not signed in.',
        },
      }),
    );
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
    fireEvent.click(screen.getByRole('radio', { name: /OpenAI Codex CLI/i }));
    expect(await screen.findByRole('button', { name: 'Connect with OpenAI' })).toBeTruthy();
    expect(screen.getByText(/connect Codex CLI here or choose the local test agent/i)).toBeTruthy();
    expect(screen.getByText(/official sign-in opens in your browser/i)).toBeTruthy();
    expect(screen.getByText('Advanced').closest('details')?.open).toBe(false);
    expect(screen.getByRole('button', { name: /Continue/ }).hasAttribute('disabled')).toBe(true);
  });

  it('adopts detected project scripts and passively validates them before completion', async () => {
    const onComplete = vi.fn<(settings: AppSettings) => Promise<void>>(() => Promise.resolve());
    render(
      <SetupWizard
        settings={settings}
        agents={agents}
        projects={[suggestionProject]}
        onComplete={onComplete}
        onSkip={() => Promise.resolve()}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Set up Forgeboard/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    expect(screen.getByLabelText<HTMLSelectElement>('Project for command suggestions').value).toBe(
      suggestionProject.id,
    );
    expect(screen.getByText('dev, test', { selector: 'code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Use “dev” for preview/u }));
    fireEvent.click(screen.getByRole('button', { name: /Use “test” for tests/u }));
    await waitFor(() => expect(commandCheck).toHaveBeenCalledTimes(2));
    expect(commandCheck.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        {
          purpose: 'preview',
          command: { executable: 'pnpm', arguments: ['run', 'dev'] },
          projectId: suggestionProject.id,
        },
        {
          purpose: 'check',
          command: { executable: 'pnpm', arguments: ['run', 'test'] },
          projectId: suggestionProject.id,
        },
      ]),
    );
    expect(screen.getAllByText(/Executable and package context ready/u)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getByRole('heading', { name: 'Getting started tour' })).toBeTruthy();
    expect(
      screen.getAllByRole('tab', {
        name: /Start with|Find your|Review before|Get help/u,
      }),
    ).toHaveLength(4);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /Open Forgeboard/ }).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Open Forgeboard/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
      developmentCommand: { executable: 'pnpm', arguments: ['run', 'dev'] },
      testCommand: { executable: 'pnpm', arguments: ['run', 'test'] },
    });
  });

  it('blocks a missing generic dependency and keeps its remediation in the UI', async () => {
    commandCheck.mockImplementation((input) =>
      Promise.resolve({
        ok: true,
        value: {
          schemaVersion: 1,
          request: input,
          state: 'executable-missing',
          ready: false,
          validationScope: 'none',
          resolvedExecutable: null,
          projectName: null,
          checkedAt: '2026-07-15T18:00:00.000Z',
          reason:
            'The configured executable was not found. Use Browse or install the dependency and reopen Forgeboard.',
          warning: null,
        },
      }),
    );
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
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.change(screen.getByLabelText('Development server executable'), {
      target: { value: 'missing-preview-tool' },
    });

    expect(await screen.findAllByText(/configured executable was not found/u)).toHaveLength(2);
    expect(screen.getByText(/install it and reopen Forgeboard, or use Browse/u)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Continue/ }).disabled).toBe(true);
  });

  it('completes agent, Docker, preview, and worktree setup entirely through controls', async () => {
    pickExecutable
      .mockResolvedValueOnce({ ok: true, value: '/usr/local/bin/pnpm' })
      .mockResolvedValueOnce({ ok: true, value: '/usr/local/bin/node' });
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
    await screen.findByText('Connected');
    const agentContinue = screen.getByRole<HTMLButtonElement>('button', { name: /Continue/ });
    await waitFor(() => expect(agentContinue.disabled).toBe(false));
    fireEvent.click(agentContinue);

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

    const developmentCommand = screen.getByRole('group', {
      name: 'Development server',
    });
    fireEvent.click(
      within(developmentCommand).getByRole('button', {
        name: 'Browse executable for Development server',
      }),
    );
    await waitFor(() =>
      expect(
        within(developmentCommand).getByLabelText<HTMLInputElement>('Development server executable')
          .value,
      ).toBe('/usr/local/bin/pnpm'),
    );
    fireEvent.change(
      screen.getByLabelText(
        'Development server arguments, one non-empty literal argument per line; empty lines ignored',
      ),
      {
        target: { value: 'run\ndev\n--host' },
      },
    );
    const testCommand = screen.getByRole('group', { name: 'Test command' });
    fireEvent.click(
      within(testCommand).getByRole('button', {
        name: 'Browse executable for Test command',
      }),
    );
    await waitFor(() =>
      expect(
        within(testCommand).getByLabelText<HTMLInputElement>('Test command executable').value,
      ).toBe('/usr/local/bin/node'),
    );
    fireEvent.change(
      screen.getByLabelText(
        'Test command arguments, one non-empty literal argument per line; empty lines ignored',
      ),
      { target: { value: '--test\n--test-reporter=spec' } },
    );
    fireEvent.change(screen.getByLabelText('Environment variable names allowed into processes'), {
      target: { value: 'PATH, HOME, CI, PATH' },
    });
    expect(screen.queryByLabelText('Cleanup policy')).toBeNull();
    fireEvent.change(screen.getByLabelText('Branch prefix'), {
      target: { value: 'workshop/' },
    });
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Continue/ }).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Open Forgeboard/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
      defaultAgent: 'codex',
      defaultPermissionProfile: 'docker-isolated',
      dockerEnabled: true,
      branchPrefix: 'workshop/',
      developmentCommand: {
        executable: '/usr/local/bin/pnpm',
        arguments: ['run', 'dev', '--host'],
      },
      testCommand: {
        executable: '/usr/local/bin/node',
        arguments: ['--test', '--test-reporter=spec'],
      },
      envAllowlist: ['PATH', 'HOME', 'CI'],
      dockerImage: readyDocker.image,
      dockerContainerExecutable: readyDocker.containerExecutable,
    });
    expect(pickExecutable).toHaveBeenCalledTimes(2);
  });

  it('remediates a missing selected CLI and validates the unsaved override before continuing', async () => {
    const missingCodex: AgentDetection = {
      ...agents[1]!,
      installed: false,
      executable: null,
      version: null,
    };
    const readiness: AgentReadinessResult = {
      schemaVersion: 1,
      agentId: 'codex',
      state: 'ready',
      ready: true,
      source: 'override',
      executable: '/canonical/bin/codex',
      version: '2.1.0',
      checkedAt: '2026-07-15T17:00:00.000Z',
      reason: null,
      warnings: [],
    };
    const checkAgentReadiness = vi.fn(() => Promise.resolve(readiness));
    pickExecutable.mockResolvedValueOnce({
      ok: true,
      value: '/chosen/bin/codex',
    });
    const onComplete = vi.fn<(settings: AppSettings) => Promise<void>>(() => Promise.resolve());
    render(
      <SetupWizard
        settings={settings}
        agents={[agents[0]!, missingCodex]}
        checkAgentReadiness={checkAgentReadiness}
        onComplete={onComplete}
        onSkip={() => Promise.resolve()}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Set up Forgeboard/ }));
    fireEvent.click(screen.getByRole('radio', { name: /OpenAI Codex CLI/ }));
    expect(screen.getByText(/Install OpenAI Codex CLI/u)).toBeTruthy();
    const continueButton = screen.getByRole<HTMLButtonElement>('button', {
      name: /Continue/,
    });
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>(/Executable override/).value).toBe(
        '/chosen/bin/codex',
      ),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Refresh OpenAI Codex CLI readiness',
      }),
    );

    await screen.findByText('Selected executable is ready');
    expect(checkAgentReadiness).toHaveBeenCalledWith({
      agentId: 'codex',
      executableOverride: '/chosen/bin/codex',
    });
    expect(screen.getByText('2.1.0')).toBeTruthy();
    expect(continueButton.disabled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
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
    await screen.findByText('Connected');
    const agentContinue = screen.getByRole<HTMLButtonElement>('button', { name: /Continue/ });
    await waitFor(() => expect(agentContinue.disabled).toBe(false));
    fireEvent.click(agentContinue);
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

  it('blocks invalid environment names and explains that secret values are not persisted', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    const continueButton = screen.getByRole<HTMLButtonElement>('button', {
      name: /Continue/,
    });

    fireEvent.change(screen.getByLabelText('Environment variable names allowed into processes'), {
      target: { value: 'PATH, NOT-VALID' },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/valid environment variable name/u);
    expect(continueButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Environment variable names allowed into processes'), {
      target: { value: 'PATH, CI' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(continueButton.disabled).toBe(false);
    expect(screen.getByText(/session values are not entered here/u)).toBeTruthy();
  });

  it('configures a truthful host Custom profile in the Safety step without file editing', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Custom/u }));

    expect(screen.getByText('Host policy is disclosure-only')).toBeTruthy();
    expect(screen.getByText(/cwd and path lists do not restrict/u)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Ask the agent to allow tests/u })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getByText('Custom', { selector: 'dd' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open Forgeboard/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
      defaultPermissionProfile: 'custom',
      customPermissionProfile: {
        runtime: 'host',
        filesystem: 'assigned-worktree-read-only',
      },
    });
  });
});
