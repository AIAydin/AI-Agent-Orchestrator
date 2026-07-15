const INVISIBLE_OR_DIRECTIONAL =
  /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

/** Renders untrusted repository text as an unambiguous quoted literal for security disclosures. */
export function displayLiteral(value: string): string {
  return escapeInvisibleOrDirectional(JSON.stringify(value));
}

/** Renders untrusted text readably while escaping controls that can reorder or hide its display. */
export function displayEscapedText(value: string): string {
  return displayLiteral(value).slice(1, -1);
}

function escapeInvisibleOrDirectional(value: string): string {
  return value.replace(INVISIBLE_OR_DIRECTIONAL, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return '';
    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  });
}
