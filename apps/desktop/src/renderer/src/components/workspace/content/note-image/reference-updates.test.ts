import { describe, expect, it } from 'vitest';

import {
  addOrReplaceImageReference,
  moveAltText,
  removeImageReference,
  type NoteImageReference,
} from './reference-updates.js';

const first = image('first.png');
const second = image('second.png');

describe('note image reference updates', () => {
  it('relinks in place, deduplicates references, and carries alternative text', () => {
    expect(addOrReplaceImageReference([first, second], second, 'first.png')).toEqual([second]);
    expect(moveAltText({ 'first.png': 'Wireframe' }, 'second.png', 'first.png')).toEqual({
      'second.png': 'Wireframe',
    });
  });

  it('clears both a reference and its path-keyed alternative text', () => {
    expect(
      removeImageReference(
        [first, second],
        { 'first.png': 'First', 'second.png': 'Second' },
        'first.png',
      ),
    ).toEqual({
      images: [second],
      altText: { 'second.png': 'Second' },
    });
  });
});

function image(relativePath: string): NoteImageReference {
  return {
    projectId: 'project-1',
    relativePath,
    kind: 'image',
    missing: false,
  };
}
