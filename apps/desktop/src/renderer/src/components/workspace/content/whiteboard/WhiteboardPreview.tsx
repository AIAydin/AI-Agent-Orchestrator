import type { WhiteboardDocument, WhiteboardElement } from './model.js';

export function WhiteboardPreview({
  document,
  selectedId,
  onSelect,
  className,
}: {
  readonly document: WhiteboardDocument;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      className={`whiteboard-preview${className === undefined ? '' : ` ${className}`}`}
      role="img"
      aria-label="Inert whiteboard preview"
      viewBox="0 0 960 640"
      style={{ background: document.appState.viewBackgroundColor }}
    >
      {document.elements
        .filter((element) => !element.isDeleted)
        .map((element) => (
          <PreviewElement
            key={element.id}
            element={element}
            selected={selectedId === element.id}
            onSelect={() => onSelect(element.id)}
          />
        ))}
    </svg>
  );
}

function PreviewElement({
  element,
  selected,
  onSelect,
}: {
  readonly element: WhiteboardElement;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const common = {
    fill: element.backgroundColor,
    stroke: element.strokeColor,
    strokeWidth: element.strokeWidth,
    opacity: element.opacity / 100,
    strokeDasharray: selected ? '6 4' : undefined,
    onClick: onSelect,
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
  if (element.type === 'arrow') {
    return <ArrowElement element={element} selected={selected} onSelect={onSelect} />;
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
      onClick={onSelect}
    >
      {element.text ?? ''}
    </text>
  );
}

function ArrowElement({
  element,
  selected,
  onSelect,
}: {
  readonly element: WhiteboardElement;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const endX = element.x + element.width;
  const endY = element.y + element.height;
  const angle = Math.atan2(element.height, element.width);
  const arrowPoint = (offset: number): string =>
    `${String(endX - 14 * Math.cos(angle + offset))},${String(endY - 14 * Math.sin(angle + offset))}`;
  return (
    <g
      fill="none"
      stroke={element.strokeColor}
      strokeWidth={element.strokeWidth}
      opacity={element.opacity / 100}
      strokeDasharray={selected ? '6 4' : undefined}
      onClick={onSelect}
    >
      <line x1={element.x} y1={element.y} x2={endX} y2={endY} />
      <polyline
        points={`${arrowPoint(-Math.PI / 6)} ${String(endX)},${String(endY)} ${arrowPoint(Math.PI / 6)}`}
      />
    </g>
  );
}

function diamondPoints(element: WhiteboardElement): string {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  return `${String(cx)},${String(element.y)} ${String(element.x + element.width)},${String(cy)} ${String(cx)},${String(element.y + element.height)} ${String(element.x)},${String(cy)}`;
}
