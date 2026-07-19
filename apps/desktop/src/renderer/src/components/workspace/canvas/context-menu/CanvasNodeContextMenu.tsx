import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Eye, Lock, Play, Trash2, Unlock } from 'lucide-react';

import type { WorkshopNode } from '../CanvasNode.js';
import { WorkspaceTooltip } from '../../shell/tooltips/WorkspaceTooltip.js';
import './context-menu.css';

export interface CanvasNodeContextMenuPosition {
  readonly x: number;
  readonly y: number;
  readonly boundsWidth: number;
  readonly boundsHeight: number;
}

interface CanvasNodeContextMenuProps {
  readonly node: WorkshopNode;
  readonly position: CanvasNodeContextMenuPosition;
  readonly readOnly: boolean;
  readonly inheritedLock: boolean;
  readonly deletionProtected: boolean;
  readonly runDisabled: boolean;
  readonly runDisabledReason?: string | undefined;
  readonly returnFocus: HTMLElement | null;
  readonly onInspect: () => void;
  readonly onRun: () => void;
  readonly onSetCollapsed: (collapsed: boolean) => void;
  readonly onSetLocked: (locked: boolean) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

const MARGIN = 8;

/** Keyboard-accessible node actions backed by the same graph mutations as the inspector. */
export function CanvasNodeContextMenu(props: CanvasNodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  const returnFocusRef = useRef(props.returnFocus);
  onCloseRef.current = props.onClose;
  returnFocusRef.current = props.returnFocus;
  const [clamped, setClamped] = useState({
    x: props.position.x,
    y: props.position.y,
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    setClamped({
      x: clamp(props.position.x, MARGIN, props.position.boundsWidth - menu.offsetWidth - MARGIN),
      y: clamp(props.position.y, MARGIN, props.position.boundsHeight - menu.offsetHeight - MARGIN),
    });
    firstEnabledItem(menu)?.focus();
  }, [props.position]);

  useEffect(() => {
    const closeForOutsidePointer = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onCloseRef.current();
    };
    const close = (): void => onCloseRef.current();
    window.addEventListener('pointerdown', closeForOutsidePointer, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', closeForOutsidePointer, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  const mutationDisabled = props.readOnly;
  const presentationDisabled = mutationDisabled || props.node.data.locked || props.inheritedLock;
  const lockDisabled = mutationDisabled || props.inheritedLock;
  const deleteDisabled = mutationDisabled || props.node.data.locked || props.deletionProtected;

  return (
    <div
      ref={menuRef}
      className="canvas-node-context-menu"
      role="menu"
      aria-label={`Actions for ${props.node.data.title}`}
      style={{ left: clamped.x, top: clamped.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKey(event, props.onClose)}
    >
      <MenuItem label="Inspect" onRun={props.onInspect} onClose={props.onClose}>
        <Eye size={14} aria-hidden="true" />
      </MenuItem>
      <MenuItem
        label="Run with dependencies"
        disabled={props.readOnly || props.runDisabled}
        reason={
          readOnlyReason(props) ??
          props.runDisabledReason ??
          (props.runDisabled ? 'This workflow cannot start right now.' : undefined)
        }
        onRun={props.onRun}
        onClose={props.onClose}
      >
        <Play size={14} aria-hidden="true" />
      </MenuItem>
      <MenuItem
        label={props.node.data.collapsed ? 'Expand' : 'Collapse'}
        disabled={presentationDisabled}
        reason={presentationReason(props)}
        onRun={() => props.onSetCollapsed(!props.node.data.collapsed)}
        onClose={props.onClose}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </MenuItem>
      <MenuItem
        label={props.node.data.locked ? 'Unlock' : 'Lock'}
        disabled={lockDisabled}
        reason={lockReason(props)}
        onRun={() => props.onSetLocked(!props.node.data.locked)}
        onClose={props.onClose}
      >
        {props.node.data.locked ? (
          <Unlock size={14} aria-hidden="true" />
        ) : (
          <Lock size={14} aria-hidden="true" />
        )}
      </MenuItem>
      <MenuItem
        label="Duplicate"
        disabled={mutationDisabled}
        reason={readOnlyReason(props)}
        onRun={props.onDuplicate}
        onClose={props.onClose}
      >
        <Copy size={14} aria-hidden="true" />
      </MenuItem>
      <MenuItem
        label="Delete"
        danger
        disabled={deleteDisabled}
        reason={deleteReason(props)}
        onRun={props.onDelete}
        onClose={props.onClose}
      >
        <Trash2 size={14} aria-hidden="true" />
      </MenuItem>
    </div>
  );
}

function MenuItem({
  children,
  label,
  disabled = false,
  danger = false,
  reason,
  onRun,
  onClose,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly reason?: string | undefined;
  readonly onRun: () => void;
  readonly onClose: () => void;
}) {
  const item = (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      className={danger ? 'danger-text' : undefined}
      disabled={disabled}
      onClick={() => {
        onRun();
        onClose();
      }}
    >
      {children}
      <span>{label}</span>
    </button>
  );
  return disabled && reason ? <WorkspaceTooltip content={reason}>{item}</WorkspaceTooltip> : item;
}

function handleMenuKey(event: React.KeyboardEvent<HTMLDivElement>, onClose: () => void): void {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    onClose();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = enabledItems(event.currentTarget);
  if (items.length === 0) return;
  if (event.key === 'Home') return items[0]?.focus();
  if (event.key === 'End') return items.at(-1)?.focus();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const offset = event.key === 'ArrowDown' ? 1 : -1;
  items[(Math.max(current, 0) + offset + items.length) % items.length]?.focus();
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
}

function firstEnabledItem(menu: HTMLElement): HTMLButtonElement | undefined {
  return enabledItems(menu)[0];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

function readOnlyReason(props: CanvasNodeContextMenuProps): string | undefined {
  return props.readOnly ? 'This collaboration role cannot edit the shared graph.' : undefined;
}

function presentationReason(props: CanvasNodeContextMenuProps): string | undefined {
  return (
    readOnlyReason(props) ??
    (props.inheritedLock
      ? 'Unlock the containing group frame before changing this node.'
      : props.node.data.locked
        ? 'Unlock this node before changing its presentation.'
        : undefined)
  );
}

function lockReason(props: CanvasNodeContextMenuProps): string | undefined {
  return (
    readOnlyReason(props) ??
    (props.inheritedLock
      ? 'Unlock the containing group frame before changing this node lock.'
      : undefined)
  );
}

function deleteReason(props: CanvasNodeContextMenuProps): string | undefined {
  return (
    readOnlyReason(props) ??
    (props.node.data.locked
      ? 'Unlock this node before deleting it.'
      : props.deletionProtected
        ? 'Unlock protected members or connected locked nodes before deleting this node.'
        : undefined)
  );
}
