import {
  ExtensionCanvasNodeTypeViewSchema,
  type ExtensionCanvasNodeTypeView,
  type ExtensionDiscoveryView,
  type InstalledExtensionView,
} from '../../../../shared/application/contracts.js';
import { normalizeExtensionFieldValues } from '../../../../shared/extensions/values.js';

export { normalizeExtensionFieldValues } from '../../../../shared/extensions/values.js';

export type ExtensionNodeAvailability = 'active' | 'quarantined' | 'unavailable';

export interface ExtensionNodeBinding {
  extensionId: string;
  extensionVersion: string;
  nodeTypeId: string;
  definition: ExtensionCanvasNodeTypeView;
  values: Record<string, unknown>;
  availability: ExtensionNodeAvailability;
}

export function extensionTemplateKey(extensionId: string, nodeTypeId: string): string {
  return `${extensionId}:${nodeTypeId}`;
}

export function createExtensionNodeBinding(
  extension: InstalledExtensionView,
  definition: ExtensionCanvasNodeTypeView,
): ExtensionNodeBinding {
  return {
    extensionId: extension.manifest.id,
    extensionVersion: extension.manifest.version,
    nodeTypeId: definition.id,
    definition: ExtensionCanvasNodeTypeViewSchema.parse(definition),
    values: initialExtensionFieldValues(definition),
    availability: 'active',
  };
}

export function resolveExtensionNodeBinding(
  input: {
    extensionId?: unknown;
    extensionVersion?: unknown;
    nodeTypeId?: unknown;
    definition?: unknown;
    values?: unknown;
  },
  discovery: Pick<ExtensionDiscoveryView, 'installed' | 'quarantined'>,
): ExtensionNodeBinding | null {
  if (
    typeof input.extensionId !== 'string' ||
    typeof input.extensionVersion !== 'string' ||
    typeof input.nodeTypeId !== 'string'
  ) {
    return null;
  }
  const persistedDefinition = ExtensionCanvasNodeTypeViewSchema.safeParse(input.definition);
  const activeExtension = discovery.installed.find(
    (extension) =>
      extension.manifest.id === input.extensionId &&
      extension.manifest.version === input.extensionVersion,
  );
  const activeDefinition = activeExtension?.manifest.contributes.canvasNodeTypes.find(
    (definition) => definition.id === input.nodeTypeId,
  );
  const definition =
    activeDefinition ?? (persistedDefinition.success ? persistedDefinition.data : null);
  if (definition === null) return null;
  const values = normalizeExtensionFieldValues(
    definition,
    isUnknownRecord(input.values) ? input.values : {},
  );
  const quarantined = discovery.quarantined.some(
    (extension) => extension.extensionId === input.extensionId,
  );
  return {
    extensionId: input.extensionId,
    extensionVersion: input.extensionVersion,
    nodeTypeId: input.nodeTypeId,
    definition,
    values,
    availability:
      activeDefinition === undefined ? (quarantined ? 'quarantined' : 'unavailable') : 'active',
  };
}

export function initialExtensionFieldValues(
  definition: ExtensionCanvasNodeTypeView,
): Record<string, unknown> {
  return normalizeExtensionFieldValues(definition, {});
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
