import { describe, expect, it, vi } from 'vitest';

import { onTextEditRequest, requestTextEdit } from './text-edit-bus.js';

describe('text edit bus', () => {
  it('notifies subscribers and stops after unsubscribe', () => {
    const seen = vi.fn();
    const unsubscribe = onTextEditRequest(seen);
    requestTextEdit('node-1');
    expect(seen).toHaveBeenCalledWith('node-1');
    unsubscribe();
    requestTextEdit('node-2');
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
