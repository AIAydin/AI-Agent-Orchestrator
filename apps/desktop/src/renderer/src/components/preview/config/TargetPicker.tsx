import { AlertTriangle, GitBranch } from 'lucide-react';

import type { PreviewTarget } from '../../../../../shared/preview/targets.js';
import type { PreviewTargetOption } from './types.js';

interface TargetPickerProps {
  nodeId: string;
  target: PreviewTarget;
  targets: readonly PreviewTargetOption[];
  readOnly: boolean;
  runtimeBusy: boolean;
  onTarget: (target: PreviewTarget) => void;
}

export function TargetPicker({
  nodeId,
  target,
  targets,
  readOnly,
  runtimeBusy,
  onTarget,
}: TargetPickerProps) {
  const selectedKey = targetKey(target);
  const selected = targets.find((candidate) => targetKey(candidate.target) === selectedKey);
  const unavailable = selected === undefined || !selected.available;

  return (
    <div className="preview-target-picker">
      <label>
        Run the preview in
        <select
          aria-label="Run the preview in"
          name={`node-${nodeId}-preview-target`}
          value={selectedKey}
          disabled={readOnly || runtimeBusy}
          onChange={(event) => {
            const option = targets.find(
              (candidate) => targetKey(candidate.target) === event.target.value,
            );
            if (option) onTarget(option.target);
          }}
        >
          {selected === undefined && target.kind === 'agent-run' ? (
            <option value={selectedKey}>Agent workspace no longer available</option>
          ) : null}
          {targets.map((option) => (
            <option
              key={targetKey(option.target)}
              value={targetKey(option.target)}
              disabled={!option.available}
            >
              {option.label} · {option.badge}
              {option.available ? '' : ' · not available'}
            </option>
          ))}
        </select>
      </label>
      <div className={`preview-target-badge ${unavailable ? 'unavailable' : ''}`}>
        {unavailable ? <AlertTriangle size={12} /> : <GitBranch size={12} />}
        <span>{selected?.badge ?? 'Agent workspace not available'}</span>
      </div>
      {unavailable ? (
        <p className="preview-target-recovery" role="status">
          {selected?.unavailableReason ??
            "That agent's workspace is no longer available. Choose your main project folder (Primary checkout) or another agent run."}
        </p>
      ) : null}
    </div>
  );
}

export function targetKey(target: PreviewTarget): string {
  return target.kind === 'primary' ? 'primary' : `agent-run:${target.runId}`;
}
