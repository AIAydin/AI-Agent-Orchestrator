import { z } from 'zod';
import { RunStatusSchema } from '@forgeboard/core/domain';

import {
  ExtensionCanvasNodeTypeViewSchema,
  type CanvasDocument,
  type ExtensionCanvasFieldView,
  type ExtensionCanvasNodeTypeView,
} from '../application/contracts.js';

const ExtensionNodeDataSchema = z
  .object({
    kind: z.literal('extension'),
    title: z.string().min(1).max(512),
    description: z.string().max(100_000),
    status: z.enum(['idle', 'waiting', ...RunStatusSchema.options]),
    locked: z.boolean(),
    collapsed: z.boolean(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
    canonicalStatus: z
      .enum([
        'draft',
        'ready',
        'queued',
        'running',
        'waiting-for-approval',
        'paused',
        'cancelling',
        'failed',
        'succeeded',
        'cancelled',
        'lost',
        'blocked',
      ])
      .optional(),
    extensionId: z.string().min(1).max(128),
    extensionVersion: z.string().min(1).max(128),
    extensionNodeTypeId: z.string().min(1).max(128),
    extensionDefinition: ExtensionCanvasNodeTypeViewSchema,
    extensionValues: z.record(z.unknown()),
    extensionAvailability: z.enum(['active', 'quarantined', 'unavailable']).optional(),
  })
  .strip();

export function sanitizeCanvasExtensionData(document: CanvasDocument): CanvasDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (node.data['kind'] !== 'extension') return node;
      const data = ExtensionNodeDataSchema.parse(node.data);
      return {
        ...node,
        data: {
          ...data,
          extensionDefinition: ExtensionCanvasNodeTypeViewSchema.parse(data.extensionDefinition),
          extensionValues: normalizeExtensionFieldValues(
            data.extensionDefinition,
            data.extensionValues,
          ),
        },
      };
    }),
  };
}

export function normalizeExtensionFieldValues(
  definition: ExtensionCanvasNodeTypeView,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    definition.fields.map((field) => {
      const value = values[field.id];
      return [
        field.id,
        isValidExtensionFieldValue(field, value)
          ? normalizeValidValue(field, value)
          : fallbackValue(field),
      ];
    }),
  );
}

function isValidExtensionFieldValue(field: ExtensionCanvasFieldView, value: unknown): boolean {
  if (field.kind === 'boolean') return typeof value === 'boolean';
  if (field.kind === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (field.minimum === undefined || value >= field.minimum) &&
      (field.maximum === undefined || value <= field.maximum)
    );
  }
  if (field.kind === 'select') {
    return typeof value === 'string' && field.options.some((option) => option.value === value);
  }
  if (field.kind === 'file-reference' || field.kind === 'directory-reference') {
    if (field.multiple) {
      return (
        Array.isArray(value) &&
        value.length <= 256 &&
        value.every((candidate) => isSafeAbsoluteReference(candidate))
      );
    }
    return value === '' || isSafeAbsoluteReference(value);
  }
  return (
    typeof value === 'string' &&
    value.length <= ('maxLength' in field ? (field.maxLength ?? 100_000) : 100_000) &&
    !value.includes('\0')
  );
}

function normalizeValidValue(field: ExtensionCanvasFieldView, value: unknown): unknown {
  if (
    (field.kind === 'file-reference' || field.kind === 'directory-reference') &&
    field.multiple &&
    Array.isArray(value)
  ) {
    return [...new Set(value)];
  }
  return value;
}

function fallbackValue(field: ExtensionCanvasFieldView): unknown {
  if (field.kind === 'boolean') return field.defaultValue ?? false;
  if (field.kind === 'number') {
    return field.defaultValue !== undefined && isValidExtensionFieldValue(field, field.defaultValue)
      ? field.defaultValue
      : null;
  }
  if (field.kind === 'select') {
    return field.defaultValue !== undefined && isValidExtensionFieldValue(field, field.defaultValue)
      ? field.defaultValue
      : (field.options[0]?.value ?? '');
  }
  if (field.kind === 'file-reference' || field.kind === 'directory-reference') {
    return field.multiple ? [] : '';
  }
  const defaultValue = 'defaultValue' in field ? field.defaultValue : undefined;
  return defaultValue !== undefined && isValidExtensionFieldValue(field, defaultValue)
    ? defaultValue
    : '';
}

function isSafeAbsoluteReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 32_768 &&
    !value.includes('\0') &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]/u.test(value))
  );
}
