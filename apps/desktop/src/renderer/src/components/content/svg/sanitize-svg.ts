const MAX_SVG_CHARACTERS = 2_000_000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'clipPath',
  'mask',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
  'use',
]);

const ALLOWED_ATTRIBUTES = new Set(
  [
    'xmlns',
    'version',
    'id',
    'role',
    'viewbox',
    'preserveaspectratio',
    'width',
    'height',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
    'points',
    'pathlength',
    'transform',
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-dashoffset',
    'opacity',
    'clip-path',
    'clip-rule',
    'mask',
    'filter',
    'offset',
    'stop-color',
    'stop-opacity',
    'gradientunits',
    'gradienttransform',
    'spreadmethod',
    'patternunits',
    'patterncontentunits',
    'patterntransform',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
    'letter-spacing',
    'word-spacing',
    'href',
  ].map((name) => name.toLowerCase()),
);

const FRAGMENT_ATTRIBUTES = new Set(['clip-path', 'mask', 'filter']);
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke']);

/**
 * Sanitizes imported/generated SVG as inert image data.
 *
 * The result is intended for an `<img>` data URL, never `innerHTML`. Active elements, event/style
 * attributes, remote resources, links, scripts, animation, and foreign HTML are removed.
 */
export function sanitizeSvg(source: string): string {
  if (source.length === 0 || source.length > MAX_SVG_CHARACTERS) {
    throw new Error('SVG source must be non-empty and no larger than 2,000,000 characters.');
  }
  if (/<!\s*(?:doctype|entity)/iu.test(source)) {
    throw new Error('SVG document declarations and entities are not accepted.');
  }
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (
    document.querySelector('parsererror') !== null ||
    document.documentElement.localName !== 'svg'
  ) {
    throw new Error('SVG source is malformed or has no SVG root.');
  }
  const sourceNamespace = document.documentElement.namespaceURI;
  if (sourceNamespace !== null && sourceNamespace !== SVG_NAMESPACE) {
    throw new Error('SVG root uses an unsupported XML namespace.');
  }

  // Build a new namespace-correct document instead of returning nodes from the untrusted parse.
  // This prevents an allowed local name in a foreign namespace from crossing the trust boundary.
  const safeDocument = document.implementation.createDocument(SVG_NAMESPACE, 'svg', null);
  copyAllowedAttributes(document.documentElement, safeDocument.documentElement);
  copyAllowedChildren(
    document.documentElement,
    safeDocument.documentElement,
    safeDocument,
    sourceNamespace,
  );
  return new XMLSerializer().serializeToString(safeDocument.documentElement);
}

export function svgDataUrl(source: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvg(source))}`;
}

function copyAllowedChildren(
  source: Element,
  target: Element,
  safeDocument: XMLDocument,
  sourceNamespace: string | null,
): void {
  for (const child of [...source.childNodes]) {
    if (child.nodeType === 3) {
      target.append(safeDocument.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (
      child.nodeType !== 1 ||
      !(child instanceof Element) ||
      child.namespaceURI !== sourceNamespace ||
      !ALLOWED_ELEMENTS.has(child.localName)
    ) {
      continue;
    }
    const safeChild = safeDocument.createElementNS(SVG_NAMESPACE, child.localName);
    copyAllowedAttributes(child, safeChild);
    copyAllowedChildren(child, safeChild, safeDocument, sourceNamespace);
    target.append(safeChild);
  }
}

function copyAllowedAttributes(source: Element, target: Element): void {
  for (const attribute of [...source.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name === 'xmlns') continue;
    if (
      name.startsWith('on') ||
      name === 'style' ||
      name === 'class' ||
      (!ALLOWED_ATTRIBUTES.has(name) && !name.startsWith('aria-')) ||
      !safeAttributeValue(name, attribute.value)
    ) {
      continue;
    }
    target.setAttribute(attribute.name, attribute.value);
  }
}

function safeAttributeValue(name: string, value: string): boolean {
  if (value.length > 100_000 || containsControlCharacter(value)) return false;
  if (name === 'href') return /^#[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(value);
  if (FRAGMENT_ATTRIBUTES.has(name)) return safeFragmentPaint(value);
  if (PAINT_ATTRIBUTES.has(name) && /url\s*\(/iu.test(value)) return safeFragmentPaint(value);
  return !/(?:javascript|vbscript|data|file|https?|ftp)\s*:/iu.test(value);
}

function safeFragmentPaint(value: string): boolean {
  return /^url\(#[A-Za-z_][A-Za-z0-9_.:-]*\)$/u.test(value.trim());
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}
