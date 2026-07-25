import type { WorkshopNode } from '../CanvasNode.js';
import { canvasNodeBounds, type CanvasNodeBounds } from './groups/group-containment.js';

/** Breathing room kept between a newly placed node and every existing node. */
const PLACEMENT_GAP = 24;
/** Grid pitch of the outward search — fine enough to tuck into gaps, coarse enough to stay fast. */
const PLACEMENT_STEP = 60;
/** Search radius in rings; past this the canvas is packed and we fall back beside everything. */
const PLACEMENT_MAX_RINGS = 40;

/**
 * Finds free space for a newly added node near `desired`: the desired spot
 * itself when nothing sits there, otherwise the first clear spot walking an
 * outward square spiral (right edge first, then below, left, and above). The
 * walk is deterministic, so the same canvas always yields the same placement.
 */
export function freeCanvasPosition(
  desired: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  obstacles: readonly CanvasNodeBounds[],
): { x: number; y: number } {
  if (isFree(desired.x, desired.y, size, obstacles)) return { x: desired.x, y: desired.y };
  for (let ring = 1; ring <= PLACEMENT_MAX_RINGS; ring += 1) {
    for (const offset of ringOffsets(ring)) {
      const x = desired.x + offset.dx * PLACEMENT_STEP;
      const y = desired.y + offset.dy * PLACEMENT_STEP;
      if (isFree(x, y, size, obstacles)) return { x, y };
    }
  }
  const rightmost = Math.max(desired.x, ...obstacles.map((rect) => rect.x + rect.width));
  return { x: rightmost + PLACEMENT_GAP, y: desired.y };
}

/** The rectangles the placement search must avoid — one per visible canvas node. */
export function canvasPlacementObstacles(nodes: readonly WorkshopNode[]): CanvasNodeBounds[] {
  return nodes.filter((node) => node.hidden !== true).map((node) => canvasNodeBounds(node));
}

function isFree(
  x: number,
  y: number,
  size: { readonly width: number; readonly height: number },
  obstacles: readonly CanvasNodeBounds[],
): boolean {
  return obstacles.every(
    (rect) =>
      x + size.width + PLACEMENT_GAP <= rect.x ||
      rect.x + rect.width + PLACEMENT_GAP <= x ||
      y + size.height + PLACEMENT_GAP <= rect.y ||
      rect.y + rect.height + PLACEMENT_GAP <= y,
  );
}

/** Perimeter of the square ring at `ring` steps, walked right → down → left → up. */
function ringOffsets(ring: number): ReadonlyArray<{ dx: number; dy: number }> {
  const offsets: Array<{ dx: number; dy: number }> = [];
  for (let dy = 0; dy <= ring; dy += 1) offsets.push({ dx: ring, dy });
  for (let dx = ring - 1; dx >= -ring; dx -= 1) offsets.push({ dx, dy: ring });
  for (let dy = ring - 1; dy >= -ring; dy -= 1) offsets.push({ dx: -ring, dy });
  for (let dx = -ring + 1; dx <= ring; dx += 1) offsets.push({ dx, dy: -ring });
  for (let dy = -ring + 1; dy <= -1; dy += 1) offsets.push({ dx: ring, dy });
  return offsets;
}
