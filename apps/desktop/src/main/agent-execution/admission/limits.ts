export function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  return value;
}

export function boundedSubset(
  value: number,
  maximum: number,
  absoluteMaximum: number,
  label: string,
): number {
  const parsed = boundedInteger(value, 1, absoluteMaximum);
  if (parsed > maximum) throw new Error(`${label} cannot exceed its global admission limit.`);
  return parsed;
}

export function countOwners<T extends { readonly ownerId: string }>(
  values: Iterable<T>,
  ownerId: string,
): number {
  let count = 0;
  for (const value of values) if (value.ownerId === ownerId) count += 1;
  return count;
}

export function countOwnerIds(values: Iterable<string>, ownerId: string): number {
  let count = 0;
  for (const value of values) if (value === ownerId) count += 1;
  return count;
}
