const CARDINALS = [-180, -90, 0, 90, 180] as const;
const CARDINAL_SNAP_DEGREES = 3;

export function normalizeRotation(value: number): number {
  const wrapped = (((value % 360) + 540) % 360) - 180;
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

export function snappedRotation(raw: number, shiftKey: boolean): number {
  const normalized = normalizeRotation(raw);
  if (shiftKey) return normalizeRotation(Math.round(normalized / 15) * 15);
  for (const cardinal of CARDINALS) {
    if (Math.abs(normalized - cardinal) <= CARDINAL_SNAP_DEGREES)
      return normalizeRotation(cardinal);
  }
  return Math.round(normalized * 10) / 10;
}
