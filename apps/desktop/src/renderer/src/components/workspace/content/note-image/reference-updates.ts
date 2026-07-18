import type { WorkshopNode } from '../../canvas/CanvasNode.js';

export type NoteImageReference = NonNullable<WorkshopNode['data']['images']>[number];

export function addOrReplaceImageReference(
  images: readonly NoteImageReference[],
  next: NoteImageReference,
  replacedPath?: string,
): NoteImageReference[] {
  const retained = images.filter(
    (image) => image.relativePath !== next.relativePath && image.relativePath !== replacedPath,
  );
  if (replacedPath === undefined) return [...retained, next];
  const replacementIndex = images.findIndex((image) => image.relativePath === replacedPath);
  if (replacementIndex < 0) return [...retained, next];
  retained.splice(Math.min(replacementIndex, retained.length), 0, next);
  return retained;
}

export function moveAltText(
  altText: Readonly<Record<string, string>>,
  nextPath: string,
  previousPath?: string,
): Record<string, string> {
  const next = { ...altText };
  if (previousPath === undefined || previousPath === nextPath) return next;
  const previous = next[previousPath];
  delete next[previousPath];
  if (next[nextPath] === undefined && previous !== undefined) next[nextPath] = previous;
  return next;
}

export function removeImageReference(
  images: readonly NoteImageReference[],
  altText: Readonly<Record<string, string>>,
  relativePath: string,
): { images: NoteImageReference[]; altText: Record<string, string> } {
  const nextAltText = { ...altText };
  delete nextAltText[relativePath];
  return {
    images: images.filter((image) => image.relativePath !== relativePath),
    altText: nextAltText,
  };
}
