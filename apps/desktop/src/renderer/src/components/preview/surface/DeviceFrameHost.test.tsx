// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewRendererOperations } from '../controller/operations.js';
import { DeviceFrameHost } from './DeviceFrameHost.js';

describe('DeviceFrameHost', () => {
  it('keeps failed-surface retry disabled for collaboration read-only viewers', async () => {
    const { operations, createSurface } = operationsThatFailCreation();
    render(
      <DeviceFrameHost
        projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        nodeId="preview-node"
        url="http://127.0.0.1:41000/"
        presetId="iphone"
        orientation="portrait"
        operations={operations}
        readOnly
      />,
    );

    expect(await screen.findByText('surface creation failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    expect(createSurface).toHaveBeenCalledTimes(1);
  });
});

function operationsThatFailCreation(): {
  operations: PreviewRendererOperations;
  createSurface: ReturnType<typeof vi.fn>;
} {
  const createSurface = vi.fn().mockRejectedValue(new Error('surface creation failed'));
  return {
    createSurface,
    operations: {
      listTargets: vi.fn(),
      createSurface,
      setSurfaceBounds: vi.fn(),
      navigateSurface: vi.fn(),
      reloadSurface: vi.fn(),
      navigateSurfaceHistory: vi.fn(),
      getSurfaceConsole: vi.fn(),
      saveSurfaceScreenshot: vi.fn(),
      openSurfaceExternally: vi.fn(),
      closeSurface: vi.fn(),
      onSurfaceEvent: vi.fn(() => vi.fn()),
    },
  };
}
