import { ViewportPortal } from '@xyflow/react';

import type { CanvasAlignmentGuides } from './alignment-guides.js';

interface AlignmentGuidesProps {
  guides: CanvasAlignmentGuides;
  zoom: number;
}

export function AlignmentGuides({ guides, zoom }: AlignmentGuidesProps) {
  if (guides.vertical === undefined && guides.horizontal === undefined) return null;
  const lineWidth = 1 / Math.max(zoom, 0.01);
  return (
    <ViewportPortal>
      {guides.vertical && (
        <div
          aria-hidden="true"
          className="canvas-alignment-guide vertical"
          style={{
            left: guides.vertical.coordinate,
            top: guides.vertical.start,
            width: lineWidth,
            height: Math.max(guides.vertical.end - guides.vertical.start, lineWidth),
          }}
        />
      )}
      {guides.horizontal && (
        <div
          aria-hidden="true"
          className="canvas-alignment-guide horizontal"
          style={{
            left: guides.horizontal.start,
            top: guides.horizontal.coordinate,
            width: Math.max(guides.horizontal.end - guides.horizontal.start, lineWidth),
            height: lineWidth,
          }}
        />
      )}
    </ViewportPortal>
  );
}
