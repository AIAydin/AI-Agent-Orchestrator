// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { trapModalFocus } from './modal-focus.js';

afterEach(() => document.body.replaceChildren());

describe('trapModalFocus', () => {
  it('wraps both directions and ignores disabled controls', () => {
    document.body.innerHTML = `
      <button id="outside">Outside</button>
      <section id="dialog" tabindex="-1">
        <button id="first">First</button>
        <button disabled>Disabled</button>
        <button id="last">Last</button>
      </section>
    `;
    const dialog = document.querySelector<HTMLElement>('#dialog');
    const first = document.querySelector<HTMLButtonElement>('#first');
    const last = document.querySelector<HTMLButtonElement>('#last');
    if (dialog === null || first === null || last === null)
      throw new Error('Missing test controls.');

    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    trapModalFocus(forward, dialog);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    trapModalFocus(backward, dialog);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });
});
