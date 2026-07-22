import type { JSX } from 'react';

import { BriefNodeFace } from '../../content/BriefNodeFace.js';
import { DiagramNodeFace } from '../../content/diagram/DiagramNodeFace.js';
import { DiffNodeFace } from '../../content/diff/DiffNodeFace.js';
import { FileNodeFace } from '../../content/file/FileNodeFace.js';
import { NoteImageNodeFace } from '../../content/note-image/NoteImageNodeFace.js';
import { WhiteboardNodeFace } from '../../content/whiteboard/WhiteboardNodeFace.js';
import { ExtensionNodeFace } from '../../content/ExtensionNodeFace.js';
import { GroupFrameNodeFace } from '../GroupFrameNodeFace.js';
import { GitPrNodeFace } from '../../git-pr/GitPrNodeFace.js';
import { PreviewNodeFace } from '../../previews/PreviewNodeFace.js';
import { AgentSessionNode } from '../../runs/agent-session/AgentSessionNode.js';
import { TerminalNodeFace } from '../../terminal/TerminalNodeFace.js';
import { ReviewGateNodeFace } from '../../workflows/faces/ReviewGateNodeFace.js';
import { TaskNodeFace } from '../../workflows/faces/TaskNodeFace.js';
import { TestNodeFace } from '../../workflows/test-node/TestNodeFace.js';
import type { WorkshopNodeData } from '../CanvasNode.js';
import './node-face.css';

/** Props every node face receives from CanvasNode. */
export interface NodeFaceProps {
  readonly id: string;
  readonly data: WorkshopNodeData;
}

export type NodeFaceComponent = (props: NodeFaceProps) => JSX.Element;

/**
 * Kind → face component. A registered kind renders its content on the node
 * face instead of the generic title/description body. Faces mount only while
 * the node is expanded; CanvasNode's header (collapse, lock, status) and
 * resizer stay outside the face.
 */
const FACES: Readonly<Partial<Record<string, NodeFaceComponent>>> = {
  agent: function AgentFace({ id, data }: NodeFaceProps) {
    return <AgentSessionNode id={id} data={data} />;
  },
  'web-preview': function WebPreviewFace({ id, data }: NodeFaceProps) {
    return <PreviewNodeFace id={id} kind="web-preview" data={data} />;
  },
  'mobile-preview': function MobilePreviewFace({ id, data }: NodeFaceProps) {
    return <PreviewNodeFace id={id} kind="mobile-preview" data={data} />;
  },
  brief: BriefNodeFace,
  diagram: DiagramNodeFace,
  diff: DiffNodeFace,
  extension: ExtensionNodeFace,
  file: FileNodeFace,
  'git-pr': GitPrNodeFace,
  'group-frame': GroupFrameNodeFace,
  'note-image': NoteImageNodeFace,
  'review-gate': ReviewGateNodeFace,
  task: TaskNodeFace,
  terminal: TerminalNodeFace,
  test: TestNodeFace,
  whiteboard: WhiteboardNodeFace,
};

export function nodeFaceForKind(kind: string): NodeFaceComponent | null {
  return FACES[kind] ?? null;
}
