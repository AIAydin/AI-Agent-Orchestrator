import { FolderSearch, Replace, type LucideProps } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';

import {
  ProjectFileBrowser,
  type ProjectFileSelection,
} from '../../../file-editor/browser/ProjectFileBrowser.js';
import { FileEditorWorkspace } from '../../../file-editor/tabs/FileEditorWorkspace.js';
import { minimumNodeDimensionsForKind } from '../../../../../../shared/canvas/node-dimensions.js';
import { useAboveMinSize } from '../../../../lib/use-above-min-size.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

const FILE_FACE_MINIMUM = minimumNodeDimensionsForKind('file');

/**
 * File face: the Monaco-backed FileEditorWorkspace fills the node body, but only
 * mounts while the node is expanded, has a usable file assignment, and is above
 * the file kind's minimum size — one Monaco instance per visible expanded file
 * node is the perf concern this guards. File assignment uses a ProjectFileBrowser
 * popover. Alt-text/relink and agent-context sharing stay in the panel until 2d.
 */
export function FileNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const reference = data.file;
  const graphReadOnly = session.graphReadOnly || interactions.readOnly;
  const [browsing, setBrowsing] = useState(reference === undefined || reference.missing);
  const large = useAboveMinSize(bodyRef, FILE_FACE_MINIMUM);

  useEffect(() => {
    if (reference === undefined || reference.missing) setBrowsing(true);
  }, [reference?.missing, reference?.projectId, reference?.relativePath]);

  const editable = reference !== undefined && !reference.missing && reference.kind === 'file';
  const editorReadOnly = graphReadOnly || data.locked || !editable;

  const selectFile = (selection: ProjectFileSelection): void => {
    session.recordHistory();
    session.updateNodeData(id, {
      file: {
        projectId: selection.projectId,
        relativePath: selection.relativePath,
        kind: 'file',
        missing: false,
        ...(selection.document.sha256 === null ? {} : { lastKnownHash: selection.document.sha256 }),
      },
    });
    setBrowsing(false);
  };

  return (
    <section className="node-face file-node-face" aria-label="File editor">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {reference === undefined ? 'No file assigned' : reference.relativePath}
        </span>
        <button
          type="button"
          aria-label={reference === undefined ? 'Choose file' : 'Change file'}
          aria-pressed={browsing}
          disabled={data.locked || graphReadOnly}
          onClick={() => setBrowsing((open) => !open)}
        >
          {reference === undefined ? <FolderSearch {...ICON} /> : <Replace {...ICON} />}
          {reference === undefined ? 'Choose' : 'Change'}
        </button>
      </div>

      <div className="node-face-body nowheel nodrag" ref={bodyRef}>
        {reference !== undefined && reference.kind !== 'file' ? (
          <p className="node-face-hint" role="status">
            This node points to a {reference.kind}. Choose a file to edit it here.
          </p>
        ) : !editable ? (
          <p className="node-face-hint">Choose a file from this project to edit it on the node.</p>
        ) : !large ? (
          <p className="node-face-hint">Make this node larger to edit the file.</p>
        ) : (
          <FileEditorWorkspace
            primary={{ projectId: reference.projectId, relativePath: reference.relativePath }}
            operations={window.forgeboard.files}
            readOnly={editorReadOnly}
            onBrowseFiles={() => setBrowsing(true)}
            onRevealInTree={() => setBrowsing(true)}
          />
        )}

        {browsing ? (
          <div className="node-face-popover" aria-label="Choose a project file">
            <ProjectFileBrowser
              projectId={session.project.id}
              operations={window.forgeboard.files}
              {...(reference === undefined ? {} : { selectedRelativePath: reference.relativePath })}
              assignmentDisabled={data.locked}
              onSelect={selectFile}
              {...(reference === undefined ? {} : { onCancel: () => setBrowsing(false) })}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

const ICON: LucideProps = { size: 12, 'aria-hidden': true };
