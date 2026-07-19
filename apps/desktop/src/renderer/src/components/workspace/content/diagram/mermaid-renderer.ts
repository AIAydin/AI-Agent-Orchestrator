import { sanitizeSvg } from '../../../content/svg/sanitize-svg.js';

type MermaidRender = (id: string, source: string) => Promise<{ svg: string }>;

let initialized = false;

export async function renderMermaidDiagram(source: string): Promise<string> {
  const mermaid = (await import('mermaid')).default;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 100_000,
      theme: 'base',
      secure: ['securityLevel', 'htmlLabels', 'startOnLoad', 'maxTextSize'],
    });
    initialized = true;
  }
  return renderMermaidSvg(source, (id, value) => mermaid.render(id, value));
}

export async function renderMermaidSvg(source: string, render: MermaidRender): Promise<string> {
  if (source.trim() === '') throw new Error('Add Mermaid source to render this diagram.');
  if (source.length > 2_000_000) throw new Error('This Mermaid diagram is too large.');
  const rendered = await render(`forgeboard-mermaid-${crypto.randomUUID()}`, source);
  return applyInertDiagramTheme(sanitizeSvg(rendered.svg));
}

/** Adds presentation attributes after sanitization; no Mermaid CSS enters the Forgeboard DOM. */
function applyInertDiagramTheme(source: string): string {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  root.setAttribute('fill', 'none');
  root.setAttribute('role', 'img');
  for (const element of [...root.querySelectorAll('rect,circle,ellipse,polygon')]) {
    element.setAttribute('fill', '#f1f0ff');
    element.setAttribute('stroke', '#6558c7');
    element.setAttribute('stroke-width', element.getAttribute('stroke-width') ?? '1.5');
  }
  for (const element of [...root.querySelectorAll('line,polyline,path')]) {
    const inMarker = element.closest('marker') !== null;
    element.setAttribute('fill', inMarker ? '#475569' : 'none');
    element.setAttribute('stroke', '#475569');
    element.setAttribute('stroke-width', element.getAttribute('stroke-width') ?? '1.5');
  }
  for (const element of [...root.querySelectorAll('text,tspan')]) {
    element.setAttribute('fill', '#172033');
    element.setAttribute('font-family', 'system-ui, sans-serif');
    element.setAttribute('font-size', element.getAttribute('font-size') ?? '14');
  }
  return sanitizeSvg(new XMLSerializer().serializeToString(root));
}
