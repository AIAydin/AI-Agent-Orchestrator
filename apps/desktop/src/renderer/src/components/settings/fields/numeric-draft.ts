/** Keeps an invalid numeric draft visibly blank without converting it into a valid value. */
export function numericDraftValue(value: number): number | '' {
  return Number.isFinite(value) ? value : '';
}
