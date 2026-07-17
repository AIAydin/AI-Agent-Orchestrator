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
        Preview target
        <select
          aria-label="Preview target"
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
            <option value={selectedKey}>Unavailable agent worktree</option>
          ) : null}
          {targets.map((option) => (
            <option
              key={targetKey(option.target)}
              value={targetKey(option.target)}
              disabled={!option.available}
            >
              {option.label} · {option.badge}
              {option.available ? '' : ' · unavailable'}
            </option>
          ))}
        </select>
      </label>
      <div className={`preview-target-badge ${unavailable ? 'unavailable' : ''}`}>
        {unavailable ? <AlertTriangle size={12} /> : <GitBranch size={12} />}
        <span>{selected?.badge ?? 'Owned worktree unavailable'}</span>
      </div>
      {unavailable ? (
        <p className="preview-target-recovery" role="status">
          {selected?.unavailableReason ??
            'That owned agent worktree is no longer available. Choose the primary checkout or another available agent run.'}
        </p>
      ) : null}
    </div>
  );
}

export function targetKey(target: PreviewTarget): string {
  return target.kind === 'primary' ? 'primary' : `agent-run:${target.runId}`;
}
