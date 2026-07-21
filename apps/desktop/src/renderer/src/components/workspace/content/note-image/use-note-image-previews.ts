import { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectImageLoadResult } from '../../../../../../shared/files/images/contracts.js';
import type { NoteImageReference } from './reference-updates.js';

export type NoteImagePreviewState = ProjectImageLoadResult | { readonly status: 'loading' };

/**
 * Loads inert previews for note-image references. When `onReconcile` is given
 * (the editable inspector), `missing` flags are reconciled against load
 * results; faces pass nothing and stay read-only observers.
 */
export function useNoteImagePreviews(
  projectId: string,
  images: readonly NoteImageReference[],
  onReconcile?: (images: NoteImageReference[]) => void,
): Readonly<Record<string, NoteImagePreviewState>> {
  const [previews, setPreviews] = useState<Readonly<Record<string, NoteImagePreviewState>>>({});
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const reconcileRef = useRef(onReconcile);
  reconcileRef.current = onReconcile;
  const signature = useMemo(
    () => images.map((image) => `${image.projectId}:${image.relativePath}`).join('\n'),
    [images],
  );

  useEffect(() => {
    let active = true;
    const current = imagesRef.current;
    if (current.length === 0) {
      setPreviews({});
      return () => {
        active = false;
      };
    }
    setPreviews(
      Object.fromEntries(current.map((image) => [image.relativePath, { status: 'loading' }])),
    );
    void Promise.all(
      current.map(async (image): Promise<[string, ProjectImageLoadResult]> => {
        if (image.projectId !== projectId) {
          return [
            image.relativePath,
            {
              status: 'unavailable',
              projectId: image.projectId,
              relativePath: image.relativePath,
              message: 'This image belongs to a different project and was not loaded.',
            },
          ];
        }
        try {
          return [
            image.relativePath,
            await window.forgeboard.files.loadImage({
              projectId,
              relativePath: image.relativePath,
            }),
          ];
        } catch (cause) {
          return [
            image.relativePath,
            {
              status: 'unavailable',
              projectId,
              relativePath: image.relativePath,
              message:
                cause instanceof Error ? cause.message : 'Forgeboard could not load this image.',
            },
          ];
        }
      }),
    ).then((loaded) => {
      if (!active) return;
      setPreviews(Object.fromEntries(loaded));
      const reconcile = reconcileRef.current;
      if (reconcile === undefined) return;
      const byPath = new Map(loaded);
      let changed = false;
      const reconciled = current.map((image) => {
        const preview = byPath.get(image.relativePath);
        if (preview?.status === 'missing' && !image.missing) {
          changed = true;
          return { ...image, missing: true };
        }
        if (preview?.status === 'available' && image.missing) {
          changed = true;
          return { ...image, missing: false };
        }
        return image;
      });
      if (changed) reconcile(reconciled);
    });
    return () => {
      active = false;
    };
  }, [projectId, signature]);

  return previews;
}
