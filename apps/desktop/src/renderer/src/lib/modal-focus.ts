const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Keeps Tab navigation inside a renderer-owned modal or alert dialog. */
export function trapModalFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || container === null) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    container.focus();
    return;
  }
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !container.contains(active);
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}
