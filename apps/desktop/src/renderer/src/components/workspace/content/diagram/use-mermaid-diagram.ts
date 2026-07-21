import { useEffect, useRef, useState } from 'react';

import { renderMermaidDiagram } from './mermaid-renderer.js';

type DiagramRenderState =
  | { readonly source: string; readonly status: 'rendered'; readonly svg: string }
  | { readonly source: string; readonly status: 'error'; readonly message: string };

export interface MermaidDiagramState {
  readonly svg: string | null;
  readonly error: string | null;
  readonly rendering: boolean;
}

/**
 * Debounced (180 ms) Mermaid render shared by the diagram node face and the
 * inspector. A render only applies to the source that produced it: once the
 * source changes, the prior SVG/error is cleared immediately and `rendering`
 * flips true until the debounced render for the new source settles.
 */
export function useMermaidDiagram(source: string): MermaidDiagramState {
  const [renderState, setRenderState] = useState<DiagramRenderState | null>(null);
  const renderSequence = useRef(0);

  useEffect(() => {
    const sequence = ++renderSequence.current;
    if (source.trim() === '') {
      setRenderState(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      void renderMermaidDiagram(source)
        .then((svg) => {
          if (sequence !== renderSequence.current) return;
          setRenderState({ source, status: 'rendered', svg });
        })
        .catch((error: unknown) => {
          if (sequence !== renderSequence.current) return;
          setRenderState({
            source,
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'This Mermaid diagram could not be rendered.',
          });
        });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [source]);

  const current = renderState?.source === source ? renderState : null;
  return {
    svg: current?.status === 'rendered' ? current.svg : null,
    error: current?.status === 'error' ? current.message : null,
    rendering: source.trim() !== '' && current === null,
  };
}
