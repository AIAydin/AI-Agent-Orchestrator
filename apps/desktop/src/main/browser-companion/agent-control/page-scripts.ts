import type { AgentPreviewElementKind } from '../../previews/webview/preview-agent-browser.js';

export interface PageElementDescriptor {
  readonly connected: boolean;
  readonly kind: AgentPreviewElementKind;
  readonly name: string;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly sensitive: boolean;
  readonly consequential: boolean;
  readonly userOnly: boolean;
  readonly opensNewWindow: boolean;
  readonly destination: string | null;
}

export interface PageElementBounds {
  readonly connected: boolean;
  readonly hitMatches: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const INTERACTIVE_ELEMENTS_EXPRESSION = String.raw`(() => {
  const selector = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  return [...document.querySelectorAll(selector)].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth &&
      style.visibility !== 'hidden' && style.display !== 'none' &&
      style.opacity !== '0' && style.pointerEvents !== 'none';
  }).slice(0, 100);
})()`;

/** Page-side element classifier shared by the CDP companion and the webview guest bridge. */
export const ELEMENT_DESCRIPTOR_SOURCE = String.raw`(element) => {
    const clean = (value, limit = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    const tag = element.tagName.toLowerCase();
    const inputType = tag === 'input' ? clean(element.type).toLowerCase() : '';
    const role = clean(element.getAttribute('role')).toLowerCase();
    const label = clean(
      element.getAttribute('aria-label') ||
      element.labels?.[0]?.innerText ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title') ||
      element.innerText ||
      element.getAttribute('alt') ||
      tag
    );
    const editable = tag === 'textarea' ||
      (tag === 'input' && !['button', 'checkbox', 'file', 'hidden', 'radio', 'reset', 'submit'].includes(inputType)) ||
      element.isContentEditable === true || role === 'textbox';
    const searchable = clean([
      inputType,
      element.getAttribute('autocomplete'),
      element.getAttribute('name'),
      element.getAttribute('id'),
      label
    ].join(' '), 500).toLowerCase();
    const authenticationPage = /(^|\/)(login|log-in|signin|sign-in|oauth|authorize|authentication)(\/|$)/i.test(location.pathname) ||
      location.hostname.toLowerCase() === 'accounts.google.com';
    const paymentPage = /(^|\/)(checkout|payment|billing)(\/|$)/i.test(location.pathname);
    const sensitive = ['password', 'file', 'hidden'].includes(inputType) ||
      /(password|passcode|one.?time|otp|verification|credit|card number|cvv|cvc|routing|social security|ssn|api.?key|access.?token|private.?key|seed phrase|recovery code)/i.test(searchable);
    const identifyingField = editable && /(email|e-mail|username|user name|account id)/i.test(searchable);
    const userOnly = sensitive || identifyingField || authenticationPage || paymentPage ||
      /(sign[ -]?in|log[ -]?in|oauth|authoriz|two.?factor|2fa|checkout|purchase|\bbuy\b|\bpay\b|upload|download|choose file|select file|attach(?:ment| file)|camera|microphone|location permission|notification|clipboard|screen (?:share|capture)|bluetooth|usb|serial)/i.test(label);
    const consequential = userOnly || inputType === 'submit' ||
      /(delete|remove|send|submit|confirm|publish|share|invite|approve|transfer|place order)/i.test(label);
    let destination = null;
    if (tag === 'a' && element.href) {
      try {
        const parsed = new URL(element.href, location.href);
        destination = (parsed.origin + parsed.pathname).slice(0, 2048);
      } catch {}
    }
    const kind = editable ? 'text-input' :
      (tag === 'a' || role === 'link') ? 'link' :
      (inputType === 'checkbox' || inputType === 'radio') ? 'toggle' :
      (tag === 'button' || role === 'button' || inputType === 'button' || inputType === 'submit') ? 'button' :
      'control';
    return {
      connected: element.isConnected === true,
      kind,
      name: label,
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      editable,
      sensitive,
      consequential,
      userOnly,
      opensNewWindow: tag === 'a' && element.target === '_blank',
      destination
    };
  }`;

export const DESCRIBE_ELEMENTS_FUNCTION = descriptorFunction(true);
export const DESCRIBE_ELEMENT_FUNCTION = descriptorFunction(false);

export const ELEMENT_BOUNDS_FUNCTION = String.raw`function () {
  const rect = this.getBoundingClientRect();
  const x = Math.max(0, Math.min(window.innerWidth - 1, rect.x + rect.width / 2));
  const y = Math.max(0, Math.min(window.innerHeight - 1, rect.y + rect.height / 2));
  const hit = document.elementFromPoint(x, y);
  return {
    connected: this.isConnected === true,
    hitMatches: hit === this || (hit !== null && this.contains(hit)),
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
}`;

export const FOCUS_ELEMENT_FUNCTION = String.raw`function (replace) {
  if (this.isConnected !== true) return false;
  this.focus({ preventScroll: true });
  if (document.activeElement !== this) return false;
  if (!replace) return true;
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    this.select();
    return document.activeElement === this;
  }
  if (this.isContentEditable) {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(this);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return document.activeElement === this;
}`;

export function parsePageElementDescriptors(value: unknown): Array<PageElementDescriptor | null> {
  if (!Array.isArray(value)) return [];
  // Preserve positions so an invalid descriptor can never be paired with a
  // different element's remote object.
  return value.map(parsePageElementDescriptor);
}

export function parsePageElementDescriptor(value: unknown): PageElementDescriptor | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (!['button', 'link', 'text-input', 'toggle', 'control'].includes(String(kind))) return null;
  if (
    typeof record['connected'] !== 'boolean' ||
    typeof record['name'] !== 'string' ||
    typeof record['disabled'] !== 'boolean' ||
    typeof record['editable'] !== 'boolean' ||
    typeof record['sensitive'] !== 'boolean' ||
    typeof record['consequential'] !== 'boolean' ||
    typeof record['userOnly'] !== 'boolean' ||
    typeof record['opensNewWindow'] !== 'boolean' ||
    (record['destination'] !== null && typeof record['destination'] !== 'string')
  )
    return null;
  return {
    connected: record['connected'],
    kind: kind as AgentPreviewElementKind,
    name: record['name'].slice(0, 200),
    disabled: record['disabled'],
    editable: record['editable'],
    sensitive: record['sensitive'],
    consequential: record['consequential'],
    userOnly: record['userOnly'],
    opensNewWindow: record['opensNewWindow'],
    destination:
      typeof record['destination'] === 'string' ? record['destination'].slice(0, 2_048) : null,
  };
}

export function parsePageElementBounds(value: unknown): PageElementBounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record['connected'] !== 'boolean' ||
    typeof record['hitMatches'] !== 'boolean' ||
    !finiteNumber(record['x']) ||
    !finiteNumber(record['y']) ||
    !finiteNumber(record['width']) ||
    !finiteNumber(record['height'])
  )
    return null;
  return {
    connected: record['connected'],
    hitMatches: record['hitMatches'],
    x: record['x'],
    y: record['y'],
    width: record['width'],
    height: record['height'],
  };
}

export function sameElementDescriptor(
  left: PageElementDescriptor,
  right: PageElementDescriptor,
): boolean {
  return (
    left.connected === right.connected &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.disabled === right.disabled &&
    left.editable === right.editable &&
    left.sensitive === right.sensitive &&
    left.consequential === right.consequential &&
    left.userOnly === right.userOnly &&
    left.opensNewWindow === right.opensNewWindow &&
    left.destination === right.destination
  );
}

function descriptorFunction(collection: boolean): string {
  return collection
    ? `function () { const describe = ${ELEMENT_DESCRIPTOR_SOURCE}; return this.map(describe); }`
    : `function () { const describe = ${ELEMENT_DESCRIPTOR_SOURCE}; return describe(this); }`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
