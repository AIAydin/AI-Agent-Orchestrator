import { useMemo } from 'react';

import { svgDataUrl } from './sanitize-svg.js';

interface SafeSvgImageProps {
  readonly source: string;
  readonly alt: string;
  readonly className?: string;
}

/** Renders sanitized SVG in an image document, not in the Artemis renderer DOM. */
export function SafeSvgImage({ source, alt, className }: SafeSvgImageProps) {
  const result = useMemo(() => {
    try {
      return { ok: true as const, url: svgDataUrl(source) };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'This image could not be shown safely.',
      };
    }
  }, [source]);
  if (!result.ok) {
    return (
      <p className={className} role="alert">
        {result.message}
      </p>
    );
  }
  return <img className={className} src={result.url} alt={alt} draggable={false} />;
}
