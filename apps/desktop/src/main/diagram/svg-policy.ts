import { DOMParser } from '@xmldom/xmldom';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'marker',
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
    'markerwidth',
    'markerheight',
    'markerunits',
    'refx',
    'refy',
    'orient',
    'marker-start',
    'marker-mid',
    'marker-end',
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

const FRAGMENT_ATTRIBUTES = new Set([
  'clip-path',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
]);
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke']);

interface XmlNode {
  readonly nodeType: number;
  readonly nextSibling: XmlNode | null;
}

interface XmlElement extends XmlNode {
  readonly namespaceURI: string | null;
  readonly localName: string;
  readonly attributes: {
    readonly length: number;
    item(index: number): { readonly name: string; readonly value: string } | null;
  };
  readonly firstChild: XmlNode | null;
}

/** Revalidates renderer-generated SVG before the main process writes it to a user-selected path. */
export function assertSafeDiagramSvg(source: string): void {
  if (/<!\s*(?:doctype|entity)|<\?xml/iu.test(source)) {
    throw new Error('The diagram export contains unsupported XML declarations.');
  }
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (
    document === undefined ||
    document.getElementsByTagName('parsererror').length > 0 ||
    root === null ||
    root.localName !== 'svg'
  ) {
    throw new Error('The diagram export is not valid SVG.');
  }
  if (root.namespaceURI !== SVG_NAMESPACE) {
    throw new Error('The diagram export uses an unsupported XML namespace.');
  }
  visit(root as unknown as XmlElement);
}

function visit(element: XmlElement): void {
  if (element.namespaceURI !== SVG_NAMESPACE || !ALLOWED_ELEMENTS.has(element.localName)) {
    throw new Error(`The diagram export contains an unsupported <${element.localName}> element.`);
  }
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute === null) continue;
    const name = attribute.name.toLowerCase();
    if (
      name.startsWith('on') ||
      name === 'style' ||
      name === 'class' ||
      (!ALLOWED_ATTRIBUTES.has(name) && !name.startsWith('aria-')) ||
      !safeAttributeValue(name, attribute.value)
    ) {
      throw new Error(`The diagram export contains an unsafe ${attribute.name} attribute.`);
    }
  }
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) visit(child as XmlElement);
    else if (child.nodeType !== 3) {
      throw new Error('The diagram export contains unsupported XML content.');
    }
  }
}

function safeAttributeValue(name: string, value: string): boolean {
  if (value.length > 100_000 || containsControlCharacter(value)) return false;
  if (name === 'xmlns') return value === SVG_NAMESPACE;
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
