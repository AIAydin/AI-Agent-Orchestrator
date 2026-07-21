import { Columns2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { PreviewSessionSnapshot } from '../../../../../shared/application/contracts.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';
import type { PreviewRendererOperations } from '../controller/operations.js';
import { DeviceFrameHost } from '../surface/DeviceFrameHost.js';
import type { PreviewPresetId } from '../devices/presets.js';
import { slotFor } from './useComparisonSessions.js';

interface ComparisonSurfaceProps {
  projectId: string;
  nodeId: string;
  leftLabel: string;
  rightLabel: string;
  leftSession: PreviewSessionSnapshot;
  rightSession: PreviewSessionSnapshot;
  leftPreset: PreviewPresetId;
  rightPreset: PreviewPresetId;
  operations: PreviewRendererOperations;
  readOnly: boolean;
  onClose: () => void;
}

export function ComparisonSurface({
  projectId,
  nodeId,
  leftLabel,
  rightLabel,
  leftSession,
  rightSession,
  leftPreset,
  rightPreset,
  operations,
  readOnly,
  onClose,
}: ComparisonSurfaceProps) {
  const surface = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== surface.current) return;
      trapModalFocus(event, surface.current);
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const leftUrl = previewUrl(leftSession);
  const rightUrl = previewUrl(rightSession);
  if (!leftUrl || !rightUrl) return null;

  return (
    <div className="preview-surface-backdrop" role="presentation">
      <section
        ref={surface}
        className="preview-surface preview-comparison-surface"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="preview-comparison-title"
      >
        <header>
          <div className="preview-surface-heading">
            <Columns2 size={17} aria-hidden="true" />
            <div>
              <strong id="preview-comparison-title">Agent worktree comparison</strong>
              <small>Two isolated local servers · two independently secured native surfaces</small>
            </div>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close worktree comparison"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="preview-comparison-stage">
          <section aria-label={`Left worktree: ${leftLabel}`}>
            <h3>{leftLabel}</h3>
            <small>Port {previewPort(leftSession)}</small>
            <DeviceFrameHost
              projectId={projectId}
              nodeId={nodeId}
              slot={slotFor('left')}
              url={leftUrl}
              presetId={leftPreset}
              orientation="portrait"
              operations={operations}
              readOnly={readOnly}
            />
          </section>
          <section aria-label={`Right worktree: ${rightLabel}`}>
            <h3>{rightLabel}</h3>
            <small>Port {previewPort(rightSession)}</small>
            <DeviceFrameHost
              projectId={projectId}
              nodeId={nodeId}
              slot={slotFor('right')}
              url={rightUrl}
              presetId={rightPreset}
              orientation="portrait"
              operations={operations}
              readOnly={readOnly}
            />
          </section>
        </div>
      </section>
    </div>
  );
}

function previewUrl(session: PreviewSessionSnapshot): string | null {
  return session.processes.find((process) => process.previewUrl)?.previewUrl ?? null;
}

function previewPort(session: PreviewSessionSnapshot): number | string {
  return session.processes.find((process) => process.previewUrl)?.port ?? 'starting';
}
