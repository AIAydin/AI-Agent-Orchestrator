import { RotateCw } from 'lucide-react';

import {
  PREVIEW_DEVICE_PRESETS,
  type PreviewOrientation,
  type PreviewPresetId,
} from './presets.js';
import './DeviceControls.css';

interface DeviceControlsProps {
  nodeId: string;
  primaryPreset: PreviewPresetId;
  secondaryPreset: PreviewPresetId;
  orientation: PreviewOrientation;
  sideBySide: boolean;
  readOnly: boolean;
  onPrimaryPreset: (value: PreviewPresetId) => void;
  onSecondaryPreset: (value: PreviewPresetId) => void;
  onOrientation: (value: PreviewOrientation) => void;
  onSideBySide: (value: boolean) => void;
}

export function DeviceControls({
  nodeId,
  primaryPreset,
  secondaryPreset,
  orientation,
  sideBySide,
  readOnly,
  onPrimaryPreset,
  onSecondaryPreset,
  onOrientation,
  onSideBySide,
}: DeviceControlsProps) {
  return (
    <fieldset className="preview-device-controls" disabled={readOnly}>
      <legend>Device presentation</legend>
      <label>
        Primary viewport
        <select
          aria-label="Primary device viewport"
          name={`node-${nodeId}-preview-device-viewport`}
          value={primaryPreset}
          onChange={(event) => onPrimaryPreset(event.target.value as PreviewPresetId)}
        >
          <PresetOptions />
        </select>
      </label>
      <button
        type="button"
        aria-label={`Rotate to ${orientation === 'portrait' ? 'landscape' : 'portrait'}`}
        onClick={() => onOrientation(orientation === 'portrait' ? 'landscape' : 'portrait')}
      >
        <RotateCw size={12} /> {orientation === 'portrait' ? 'Portrait' : 'Landscape'}
      </button>
      <label className="preview-checkbox-option">
        <input
          type="checkbox"
          name={`node-${nodeId}-preview-side-by-side`}
          checked={sideBySide}
          onChange={(event) => onSideBySide(event.target.checked)}
        />
        Compare side by side
      </label>
      {sideBySide ? (
        <label>
          Secondary viewport
          <select
            aria-label="Secondary device viewport"
            name={`node-${nodeId}-preview-secondary-device-viewport`}
            value={secondaryPreset}
            onChange={(event) => onSecondaryPreset(event.target.value as PreviewPresetId)}
          >
            <PresetOptions />
          </select>
        </label>
      ) : null}
      <p className="preview-capability-note" role="note">
        Forgeboard automatically enables Chromium touch emulation for phone and tablet surfaces.
        Desktop and laptop surfaces keep ordinary pointer input.
      </p>
    </fieldset>
  );
}

function PresetOptions() {
  return Object.entries(PREVIEW_DEVICE_PRESETS).map(([id, preset]) => (
    <option key={id} value={id}>
      {preset.label} · {preset.width} × {preset.height}
    </option>
  ));
}
