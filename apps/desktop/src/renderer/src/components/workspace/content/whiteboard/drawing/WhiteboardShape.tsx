import type { JSX } from 'react';

import { arrowEndpoints, strokePath, type WhiteboardElement } from '../model.js';

/**
 * The single element→SVG renderer. Both the interactive canvas and the in-progress draft
 * draw through this, so what you see while dragging is what gets committed.
 * Its string counterpart for file export lives in `../svg.ts`.
 */
export function WhiteboardShape({
  element,
  selected,
  onSelect,
}: {
  readonly element: WhiteboardElement;
  readonly selected: boolean;
  readonly onSelect?: (() => void) | undefined;
}): JSX.Element {
  const common = {
    fill: element.backgroundColor,
    stroke: element.strokeColor,
    strokeWidth: element.strokeWidth,
    opacity: element.opacity / 100,
    strokeDasharray: selected ? '6 4' : undefined,
    onPointerDown: onSelect,
  };
  if (element.type === 'rectangle') {
    return (
      <rect
        {...common}
        x={element.x}
        y={element.y}
        width={element.width}
        height={element.height}
        rx={6}
      />
    );
  }
  if (element.type === 'ellipse') {
    return (
      <ellipse
        {...common}
        cx={element.x + element.width / 2}
        cy={element.y + element.height / 2}
        rx={element.width / 2}
        ry={element.height / 2}
      />
    );
  }
  if (element.type === 'diamond') {
    return <polygon {...common} points={diamondPoints(element)} />;
  }
  if (element.type === 'freedraw') {
    return (
      <path
        d={strokePath(element)}
        fill="none"
        stroke={element.strokeColor}
        strokeWidth={element.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={element.opacity / 100}
        strokeDasharray={selected ? '6 4' : undefined}
        onPointerDown={onSelect}
      />
    );
  }
  if (element.type === 'arrow') {
    return <ArrowShape element={element} selected={selected} onSelect={onSelect} />;
  }
  return (
    <text
      x={element.x}
      y={element.y + (element.fontSize ?? 20)}
      fill={element.strokeColor}
      fontFamily="system-ui, sans-serif"
      fontSize={element.fontSize ?? 20}
      opacity={element.opacity / 100}
      stroke={selected ? element.strokeColor : 'none'}
      strokeDasharray={selected ? '6 4' : undefined}
      onPointerDown={onSelect}
    >
      {element.text ?? ''}
    </text>
  );
}

function ArrowShape({
  element,
  selected,
  onSelect,
}: {
  readonly element: WhiteboardElement;
  readonly selected: boolean;
  readonly onSelect?: (() => void) | undefined;
}): JSX.Element {
  const { start, end } = arrowEndpoints(element);
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
  const head = (offset: number): string =>
    `${String(end[0] - 14 * Math.cos(angle + offset))},${String(end[1] - 14 * Math.sin(angle + offset))}`;
  return (
    <g
      fill="none"
      stroke={element.strokeColor}
      strokeWidth={element.strokeWidth}
      opacity={element.opacity / 100}
      strokeDasharray={selected ? '6 4' : undefined}
      onPointerDown={onSelect}
    >
      <line x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} />
      <polyline
        points={`${head(-Math.PI / 6)} ${String(end[0])},${String(end[1])} ${head(Math.PI / 6)}`}
      />
    </g>
  );
}

function diamondPoints(element: WhiteboardElement): string {
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  return `${String(centerX)},${String(element.y)} ${String(element.x + element.width)},${String(centerY)} ${String(centerX)},${String(element.y + element.height)} ${String(element.x)},${String(centerY)}`;
}
