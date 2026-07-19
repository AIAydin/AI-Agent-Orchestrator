import { cloneElement, useId, type ReactElement } from 'react';

interface TooltipTargetProps {
  readonly content: string;
  readonly children: ReactElement<{
    'aria-describedby'?: string;
    'aria-label'?: string;
    disabled?: boolean;
  }>;
}

/** Visible mouse and keyboard tooltip for compact workspace controls. */
export function WorkspaceTooltip({ content, children }: TooltipTargetProps) {
  const id = useId();
  const disabled = children.props.disabled === true;
  return (
    <span
      className="workspace-tooltip-target"
      {...(disabled
        ? {
            role: 'group',
            tabIndex: 0,
            'aria-label': `${children.props['aria-label'] ?? 'Action'} unavailable`,
            'aria-describedby': id,
          }
        : {})}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span className="workspace-tooltip-content" id={id} role="tooltip">
        {content}
      </span>
    </span>
  );
}
