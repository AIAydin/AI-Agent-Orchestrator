// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExtensionDiscoveryView,
  ExtensionInstallPlanView,
  InstalledExtensionView,
} from '../../../../../shared/application/contracts.js';
import { DockerConfiguration } from '../../docker/DockerConfiguration.js';
import { ExtensionSettings } from '../../extensions/ExtensionSettings.js';

const extensionList = vi.fn();
const extensionChoose = vi.fn();
const extensionApprove = vi.fn();
const extensionRemove = vi.fn();

beforeEach(() => {
  extensionList.mockReset();
  extensionChoose.mockReset();
  extensionApprove.mockReset();
  extensionRemove.mockReset();
  extensionList.mockResolvedValue({ ok: true, value: discovery() });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      extensions: {
        list: extensionList,
        choose: extensionChoose,
        approve: extensionApprove,
        remove: extensionRemove,
      },
    },
  });
});

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

  it('renders ordinary local extension discovery actions', async () => {
    render(<ExtensionSettings onChanged={vi.fn()} onError={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Local extensions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose extension folder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose extension file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(await screen.findByText('No extensions installed yet')).toBeTruthy();
  });

  it('reviews and applies extension install, update, and removal through renderer controls', async () => {
    extensionChoose
      .mockResolvedValueOnce({ ok: true, value: extensionPlan('install', '1.0.0') })
      .mockResolvedValueOnce({ ok: true, value: extensionPlan('update', '1.1.0') });
    extensionApprove
      .mockResolvedValueOnce({ ok: true, value: discovery(installedExtension('1.0.0')) })
      .mockResolvedValueOnce({ ok: true, value: discovery(installedExtension('1.1.0')) });
    extensionRemove.mockResolvedValueOnce({ ok: true, value: discovery() });
    const onChanged = vi.fn(() => Promise.resolve());
    render(<ExtensionSettings onChanged={onChanged} onError={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Choose extension folder' }));
    expect(await screen.findByRole('heading', { name: 'Review extension install' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed these exact details/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to confirmation' }));
    await waitFor(() =>
      expect(extensionApprove).toHaveBeenNthCalledWith(1, {
        planId: '00000000-0000-4000-8000-000000000001',
        confirmed: true,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Update from folder' }));
    expect(await screen.findByRole('heading', { name: 'Review extension update' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed these exact details/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm update' }));
    await waitFor(() => expect(extensionApprove).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('heading', { name: 'Remove Example notes?' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Type example.notes to confirm/u }), {
      target: { value: 'example.notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove extension' }));
    await waitFor(() =>
      expect(extensionRemove).toHaveBeenCalledWith({
        extensionId: 'example.notes',
        confirmation: 'example.notes',
      }),
    );
    expect(onChanged).toHaveBeenCalledTimes(3);
  });
});

function discovery(installed?: InstalledExtensionView): ExtensionDiscoveryView {
  return {
    registryPath: '/tmp/forgeboard/extensions.json',
    installed: installed ? [installed] : [],
    quarantined: [],
    invalid: [],
  };
}

function extensionManifest(version: string): ExtensionInstallPlanView['manifest'] {
  return {
    schemaVersion: 1,
    id: 'example.notes',
    name: 'Example notes',
    version,
    description: 'Local notes for the canvas.',
    publisher: 'Example',
    requestedPermissions: ['canvas.node.register', 'canvas.data.persist'],
    contributes: { agentAdapters: [], canvasNodeTypes: [] },
  };
}

function extensionPlan(
  operation: ExtensionInstallPlanView['operation'],
  version: string,
): ExtensionInstallPlanView {
  return {
    planId:
      operation === 'install'
        ? '00000000-0000-4000-8000-000000000001'
        : '00000000-0000-4000-8000-000000000002',
    operation,
    currentVersion: operation === 'install' ? null : '1.0.0',
    manifest: extensionManifest(version),
    manifestJson: '{"schemaVersion":1}',
    manifestDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    sourcePath: '/tmp/example.notes',
    requestedPermissions: ['canvas.node.register', 'canvas.data.persist'],
    expiresAt: '2026-07-18T20:00:00.000Z',
  };
}

function installedExtension(version: string): InstalledExtensionView {
  return {
    manifest: extensionManifest(version),
    manifestJson: '{"schemaVersion":1}',
    record: {
      schemaVersion: 1,
      extensionId: 'example.notes',
      version,
      manifestDigest: 'a'.repeat(64),
      snapshotDigest: 'b'.repeat(64),
      grantedPermissions: ['canvas.node.register', 'canvas.data.persist'],
      sourcePath: '/tmp/example.notes',
      installedAt: '2026-07-18T18:00:00.000Z',
      updatedAt: '2026-07-18T18:00:00.000Z',
    },
    trustState: 'active',
    approvedAt: '2026-07-18T18:00:00.000Z',
  };
}
