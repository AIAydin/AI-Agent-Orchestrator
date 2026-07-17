export const PREVIEW_DEVICE_PRESETS = {
  desktop: { label: 'Desktop', width: 1440, height: 900, family: 'desktop' },
  laptop: { label: 'Laptop', width: 1280, height: 800, family: 'desktop' },
  iphone: { label: 'iPhone', width: 390, height: 844, family: 'phone' },
  pixel: { label: 'Android', width: 412, height: 915, family: 'phone' },
  tablet: { label: 'Tablet', width: 820, height: 1180, family: 'tablet' },
} as const;

export type PreviewPresetId = keyof typeof PREVIEW_DEVICE_PRESETS;
export type PreviewOrientation = 'portrait' | 'landscape';

export function previewPreset(value: unknown, fallback: PreviewPresetId): PreviewPresetId {
  return typeof value === 'string' && value in PREVIEW_DEVICE_PRESETS
    ? (value as PreviewPresetId)
    : fallback;
}

export function orientedViewport(presetId: PreviewPresetId, orientation: PreviewOrientation) {
  const preset = PREVIEW_DEVICE_PRESETS[presetId];
  return orientation === 'portrait'
    ? { width: preset.width, height: preset.height }
    : { width: preset.height, height: preset.width };
}
