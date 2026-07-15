import type { JsonValue } from '@forgeboard/core/domain';

export function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  const normalized = jsonValue(value);
  return isRecord(normalized) ? normalized : undefined;
}

export function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];
    for (const child of value) {
      const parsed = jsonValue(child);
      if (parsed === undefined) return undefined;
      normalized.push(parsed);
    }
    return normalized;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const normalized: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const parsed = jsonValue(child);
    if (parsed === undefined) return undefined;
    normalized[key] = parsed;
  }
  return normalized;
}

export function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function unknownRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((child) => typeof child === 'string')
    ? value
    : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
