import { Fragment, type ReactNode } from 'react';

import { parseSafeMarkdown, type MarkdownBlock, type MarkdownInline } from './markdown-model.js';
import './safe-markdown.css';

interface SafeMarkdownProps {
  readonly markdown: string;
  readonly className?: string;
  readonly emptyLabel?: string;
  /** Opening remains caller-controlled so external navigation can use Forgeboard's approval gate. */
  readonly onOpenLink?: (url: string) => void;
}

export function SafeMarkdown({
  markdown,
  className = '',
  emptyLabel = 'Nothing has been written yet.',
  onOpenLink,
}: SafeMarkdownProps) {
  const blocks = parseSafeMarkdown(markdown);
  return (
    <div className={`safe-markdown ${className}`.trim()} data-testid="safe-markdown">
      {blocks.length === 0 ? <p className="safe-markdown-empty">{emptyLabel}</p> : null}
      {blocks.map((block, index) => renderBlock(block, index, onOpenLink))}
    </div>
  );
}

function renderBlock(
  block: MarkdownBlock,
  key: number,
  onOpenLink: SafeMarkdownProps['onOpenLink'],
): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const children = renderInline(block.children, `${key}-heading`, onOpenLink);
      if (block.level === 1) return <h1 key={key}>{children}</h1>;
      if (block.level === 2) return <h2 key={key}>{children}</h2>;
      if (block.level === 3) return <h3 key={key}>{children}</h3>;
      if (block.level === 4) return <h4 key={key}>{children}</h4>;
      if (block.level === 5) return <h5 key={key}>{children}</h5>;
      return <h6 key={key}>{children}</h6>;
    }
    case 'paragraph':
      return <p key={key}>{renderLines(block.lines, `${key}-paragraph`, onOpenLink)}</p>;
    case 'quote':
      return (
        <blockquote key={key}>{renderLines(block.lines, `${key}-quote`, onOpenLink)}</blockquote>
      );
    case 'code':
      return (
        <pre key={key} data-language={block.language}>
          <code>{block.value}</code>
        </pre>
      );
    case 'notice':
      return (
        <p key={key} className="safe-markdown-notice" role="status">
          {block.message}
        </p>
      );
    case 'rule':
      return <hr key={key} />;
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className={item.checked === undefined ? undefined : 'task-list-item'}>
          {item.checked === undefined ? null : (
            <input
              type="checkbox"
              name="markdown-task-state"
              checked={item.checked}
              readOnly
              tabIndex={-1}
              aria-label={item.checked ? 'Completed item' : 'Incomplete item'}
            />
          )}
          <span>{renderInline(item.children, `${key}-item-${index}`, onOpenLink)}</span>
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
  }
}

function renderLines(
  lines: readonly (readonly MarkdownInline[])[],
  key: string,
  onOpenLink: SafeMarkdownProps['onOpenLink'],
): ReactNode[] {
  return lines.map((line, index) => (
    <Fragment key={`${key}-${index}`}>
      {index === 0 ? null : <br />}
      {renderInline(line, `${key}-${index}`, onOpenLink)}
    </Fragment>
  ));
}

function renderInline(
  tokens: readonly MarkdownInline[],
  key: string,
  onOpenLink: SafeMarkdownProps['onOpenLink'],
): ReactNode[] {
  return tokens.map((token, index) => {
    const tokenKey = `${key}-${index}`;
    if (token.kind === 'text') return <Fragment key={tokenKey}>{token.value}</Fragment>;
    if (token.kind === 'code') return <code key={tokenKey}>{token.value}</code>;
    const children = renderInline(token.children, tokenKey, onOpenLink);
    if (token.kind === 'strong') return <strong key={tokenKey}>{children}</strong>;
    if (token.kind === 'emphasis') return <em key={tokenKey}>{children}</em>;
    if (token.kind === 'strikethrough') return <s key={tokenKey}>{children}</s>;
    if (token.url === null) {
      return (
        <span
          key={tokenKey}
          className="unsafe-markdown-link"
          title="This link was blocked for safety"
        >
          {children}
        </span>
      );
    }
    if (onOpenLink === undefined) {
      return (
        <span
          key={tokenKey}
          className="safe-markdown-link unavailable"
          title="Opening links is not available here"
        >
          {children}
        </span>
      );
    }
    return (
      <button
        key={tokenKey}
        type="button"
        className="safe-markdown-link"
        title={token.title}
        onClick={() => onOpenLink(token.url as string)}
      >
        {children}
      </button>
    );
  });
}
