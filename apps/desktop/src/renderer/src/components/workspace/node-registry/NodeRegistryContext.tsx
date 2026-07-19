import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { ExtensionTemplate } from '../model/types.js';
import { BUILT_IN_NODE_REGISTRY, NodeTypeRegistry } from './registry.js';

const NodeRegistryContext = createContext<NodeTypeRegistry>(BUILT_IN_NODE_REGISTRY);

export function NodeRegistryProvider({
  extensionTemplates,
  registry: suppliedRegistry,
  children,
}: {
  readonly extensionTemplates: readonly ExtensionTemplate[];
  readonly registry?: NodeTypeRegistry;
  readonly children: ReactNode;
}) {
  const registry = useMemo(
    () => suppliedRegistry ?? nodeRegistryFromTemplates(extensionTemplates),
    [extensionTemplates, suppliedRegistry],
  );
  return <NodeRegistryContext.Provider value={registry}>{children}</NodeRegistryContext.Provider>;
}

export function nodeRegistryFromTemplates(
  extensionTemplates: readonly ExtensionTemplate[],
): NodeTypeRegistry {
  return new NodeTypeRegistry(
    extensionTemplates.map(({ extension, definition }) => ({
      extensionId: extension.manifest.id,
      extensionVersion: extension.manifest.version,
      definition,
    })),
  );
}

export function useNodeTypeRegistry(): NodeTypeRegistry {
  return useContext(NodeRegistryContext);
}
