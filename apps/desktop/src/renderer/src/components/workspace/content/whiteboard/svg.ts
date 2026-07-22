import {
  arrowEndpoints,
  strokePath,
  VIEW_BOX_HEIGHT,
  VIEW_BOX_WIDTH,
  type WhiteboardDocument,
  type WhiteboardElement,
} from './model.js';

export function whiteboardSvg(document: WhiteboardDocument, selectedId?: string): string {
  const elements = document.elements
    .filter((element) => !element.isDeleted)
    .map((element) => elementSvg(element, selectedId === element.id))
    .join('');
  const size = `width="${String(VIEW_BOX_WIDTH)}" height="${String(VIEW_BOX_HEIGHT)}"`;
  const background = escapeAttribute(document.appState.viewBackgroundColor);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(VIEW_BOX_WIDTH)} ${String(VIEW_BOX_HEIGHT)}" ${size}><rect ${size} fill="${background}"/>${elements}</svg>`;
}

function elementSvg(element: WhiteboardElement, selected: boolean): string {
  const stroke = escapeAttribute(element.strokeColor);
  const fill = escapeAttribute(element.backgroundColor);
  const opacity = String(element.opacity / 100);
  const selectedStroke = selected ? ' stroke-dasharray="6 4"' : '';
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${String(element.strokeWidth)}" opacity="${opacity}"${selectedStroke}`;
  if (element.type === 'rectangle') {
    return `<rect x="${number(element.x)}" y="${number(element.y)}" width="${number(element.width)}" height="${number(element.height)}" rx="6" ${common}/>`;
  }
  if (element.type === 'ellipse') {
    return `<ellipse cx="${number(element.x + element.width / 2)}" cy="${number(element.y + element.height / 2)}" rx="${number(element.width / 2)}" ry="${number(element.height / 2)}" ${common}/>`;
  }
  if (element.type === 'diamond') {
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    const points = `${number(centerX)},${number(element.y)} ${number(element.x + element.width)},${number(centerY)} ${number(centerX)},${number(element.y + element.height)} ${number(element.x)},${number(centerY)}`;
    return `<polygon points="${points}" ${common}/>`;
  }
  if (element.type === 'freedraw') {
    const outline = `fill="none" stroke="${stroke}" stroke-width="${String(element.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${selectedStroke}`;
    return `<path d="${escapeAttribute(strokePath(element))}" ${outline}/>`;
  }
  if (element.type === 'arrow') {
    const { start, end } = arrowEndpoints(element);
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const leftX = end[0] - 14 * Math.cos(angle - Math.PI / 6);
    const leftY = end[1] - 14 * Math.sin(angle - Math.PI / 6);
    const rightX = end[0] - 14 * Math.cos(angle + Math.PI / 6);
    const rightY = end[1] - 14 * Math.sin(angle + Math.PI / 6);
    const head = `${number(leftX)},${number(leftY)} ${number(end[0])},${number(end[1])} ${number(rightX)},${number(rightY)}`;
    return `<g fill="none" stroke="${stroke}" stroke-width="${String(element.strokeWidth)}" opacity="${opacity}"${selectedStroke}><line x1="${number(start[0])}" y1="${number(start[1])}" x2="${number(end[0])}" y2="${number(end[1])}"/><polyline points="${head}"/></g>`;
  }
  return `<text x="${number(element.x)}" y="${number(element.y + (element.fontSize ?? 20))}" fill="${stroke}" font-family="system-ui, sans-serif" font-size="${number(element.fontSize ?? 20)}" opacity="${opacity}"${selectedStroke}>${escapeText(element.text ?? '')}</text>`;
}

function number(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
