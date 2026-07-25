import { Film, Replace, type LucideProps } from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';

import type { ProjectVideoLoadResult } from '../../../../../../shared/files/videos/contracts.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import './video-node-face.css';

export function VideoNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const reference = data.file;
  const [result, setResult] = useState<ProjectVideoLoadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A stale `missing` flag from an old save must not block a retry, so the
  // load is attempted whenever a file reference exists.
  useEffect(() => {
    let current = true;
    setResult(null);
    setError(null);
    if (reference === undefined || reference.kind !== 'file') return;
    void window.forgeboard.files
      .loadVideo({
        projectId: reference.projectId,
        relativePath: reference.relativePath,
      })
      .then((value) => {
        if (current) setResult(value);
      })
      .catch((cause: unknown) => {
        if (current)
          setError(cause instanceof Error ? cause.message : 'Video playback is unavailable.');
      });
    return () => {
      current = false;
    };
  }, [reference?.kind, reference?.projectId, reference?.relativePath]);

  const choose = async (): Promise<void> => {
    try {
      const selected = await window.forgeboard.files.chooseVideo({
        projectId: session.project.id,
      });
      if (selected === null) return;
      session.recordHistory();
      session.updateNodeData(id, { file: selected });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The video could not be selected.');
    }
  };

  const disabled = data.locked || session.graphReadOnly || interactions.readOnly;
  const unavailableMessage = result !== null && result.status !== 'available' ? result.message : null;
  return (
    <section className="node-face video-node-face" aria-label="Video player">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {reference?.relativePath ?? 'No video assigned'}
        </span>
        <button type="button" disabled={disabled} onClick={() => void choose()}>
          {reference === undefined ? <Film {...ICON} /> : <Replace {...ICON} />}
          {reference === undefined ? 'Choose' : 'Change'}
        </button>
      </div>
      <div className="node-face-body video-node-face-body nowheel nodrag">
        {error === null && result?.status === 'available' ? (
          <video
            controls
            preload="metadata"
            src={result.playbackUrl}
            onError={() => setError("This video couldn't be played. Try choosing it again.")}
          >
            Your system cannot play this video format.
          </video>
        ) : (
          <p className="node-face-hint" role="status">
            {error ?? unavailableMessage ?? 'Choose an MP4, WebM, or Ogg video from this project.'}
          </p>
        )}
      </div>
    </section>
  );
}

const ICON: LucideProps = { size: 12, 'aria-hidden': true };
