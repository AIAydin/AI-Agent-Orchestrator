import { Columns2, X } from 'lucide-react';

import type { PreviewSessionSnapshot } from '../../../../../shared/application/contracts.js';
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
  readOnly,
  onClose,
}: ComparisonSurfaceProps) {
  const leftUrl = previewUrl(leftSession);
  const rightUrl = previewUrl(rightSession);
  if (!leftUrl || !rightUrl) return null;

  return (
    <div className="preview-surface-backdrop" role="presentation">
      <section
        className="preview-surface preview-comparison-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-comparison-title"
      >
        <header>
          <div className="preview-surface-heading">
            <Columns2 size={17} />
            <div>
              <strong id="preview-comparison-title">Agent worktree comparison</strong>
              <small>Two isolated local servers · two independently secured native surfaces</small>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close worktree comparison">
            <X size={15} />
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
