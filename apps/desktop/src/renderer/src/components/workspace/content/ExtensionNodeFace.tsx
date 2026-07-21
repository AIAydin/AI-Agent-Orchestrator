import type { JSX } from 'react';

import { DeclarativeExtensionInspector } from '../../extensions/DeclarativeExtensionInspector.js';
import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';

/**
 * Extension face: renders the declarative extension's value form on the node
 * face. Reuses DeclarativeExtensionInspector so extension-provided fields, their
 * availability state, and the file/folder pickers behave exactly as they do in
 * the inspector; mutations flow through the session context.
 */
export function ExtensionNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const definition = data.extensionDefinition;
  const extensionId = data.extensionId;
  const extensionVersion = data.extensionVersion;

  if (definition === undefined || extensionId === undefined || extensionVersion === undefined) {
    return (
      <section className="node-face extension-node-face" aria-label="Extension node">
        <p className="node-face-hint">
          This extension node is missing its definition. Reinstall or update the extension to edit it
          here.
        </p>
      </section>
    );
  }

  return (
    <section className="node-face extension-node-face" aria-label="Extension node">
      <fieldset className="node-face-body nowheel nodrag" disabled={readOnly}>
        <DeclarativeExtensionInspector
          definition={definition}
          extensionId={extensionId}
          extensionVersion={extensionVersion}
          values={data.extensionValues ?? {}}
          availability={data.extensionAvailability ?? 'unavailable'}
          onChange={(extensionValues) => session.updateNodeData(id, { extensionValues })}
          onError={(message) => session.reportError(message)}
        />
      </fieldset>
    </section>
  );
}
