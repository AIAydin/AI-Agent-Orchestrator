import type { WhiteboardDocument, WhiteboardElement } from './model.js';

const WIDTH = 960;
const HEIGHT = 640;

export function whiteboardSvg(document: WhiteboardDocument, selectedId?: string): string {
  const elements = document.elements
    .filter((element) => !element.isDeleted)
    .map((element) => elementSvg(element, selectedId === element.id))
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" width="${String(WIDTH)}" height="${String(HEIGHT)}"><rect width="${String(WIDTH)}" height="${String(HEIGHT)}" fill="${escapeAttribute(document.appState.viewBackgroundColor)}"/>${elements}</svg>`;
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
  if (element.type === 'arrow') {
    const endX = element.x + element.width;
    const endY = element.y + element.height;
    const angle = Math.atan2(element.height, element.width);
    const leftX = endX - 14 * Math.cos(angle - Math.PI / 6);
    const leftY = endY - 14 * Math.sin(angle - Math.PI / 6);
    const rightX = endX - 14 * Math.cos(angle + Math.PI / 6);
    const rightY = endY - 14 * Math.sin(angle + Math.PI / 6);
    return `<g fill="none" stroke="${stroke}" stroke-width="${String(element.strokeWidth)}" opacity="${opacity}"${selectedStroke}><line x1="${number(element.x)}" y1="${number(element.y)}" x2="${number(endX)}" y2="${number(endY)}"/><polyline points="${number(leftX)},${number(leftY)} ${number(endX)},${number(endY)} ${number(rightX)},${number(rightY)}"/></g>`;
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
