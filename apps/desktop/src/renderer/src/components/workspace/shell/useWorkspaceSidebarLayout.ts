import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  loadViewPreferences,
  saveViewPreferences,
  type ViewPreferences,
} from '../../../lib/view-preferences.js';
import {
  clampSidebarWidth,
  NARROW_RAIL_DEFAULT_WIDTH,
  RAIL_DEFAULT_WIDTH,
  RAIL_WIDTH_RANGE,
  reclampSidebarWidths,
  type SidebarRange,
} from './sidebar-resize.js';

const NARROW_LAYOUT_QUERY = '(max-width: 1180px)';
const STACKED_LAYOUT_MAX_WIDTH = 900;
const SAVE_DEBOUNCE_MS = 300;

export interface SidebarLayoutControls {
  /** Effective width in pixels (stored preference or the responsive default). */
  readonly width: number;
  readonly range: SidebarRange;
  readonly resize: (width: number) => void;
  readonly reset: () => void;
}

export interface WorkspaceSidebarLayout {
  readonly gridStyle: CSSProperties;
  readonly rail: SidebarLayoutControls;
}

function narrowLayoutMatches(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_LAYOUT_QUERY).matches;
}

/**
 * Owns the user-adjustable width of the project rail column. `null` means "use
 * the stylesheet default", so responsive defaults keep applying until the user
 * drags the divider.
 */
export function useWorkspaceSidebarLayout(): WorkspaceSidebarLayout {
  const [preferences, setPreferences] = useState<ViewPreferences>(loadViewPreferences);
  const [narrowLayout, setNarrowLayout] = useState(narrowLayoutMatches);

  const railDefault = narrowLayout ? NARROW_RAIL_DEFAULT_WIDTH : RAIL_DEFAULT_WIDTH;
  const railWidth = preferences.railWidth ?? railDefault;
  const effectiveWidths = useRef({ railWidth });
  effectiveWidths.current = { railWidth };

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(NARROW_LAYOUT_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrowLayout(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const reclamp = () => {
      if (window.innerWidth <= STACKED_LAYOUT_MAX_WIDTH) return;
      setPreferences((current) => {
        if (current.railWidth === null) return current;
        const clamped = reclampSidebarWidths(effectiveWidths.current, window.innerWidth);
        const nextRail =
          current.railWidth === null && clamped.railWidth === effectiveWidths.current.railWidth
            ? null
            : clamped.railWidth;
        return current.railWidth === nextRail ? current : { ...current, railWidth: nextRail };
      });
    };
    let trailing: number | null = null;
    const onWindowResize = () => {
      reclamp();
      // Resize events can arrive before the window reaches its final size, so
      // run one trailing pass against the settled dimensions.
      if (trailing !== null) window.clearTimeout(trailing);
      trailing = window.setTimeout(reclamp, 150);
    };
    window.addEventListener('resize', onWindowResize);
    return () => {
      if (trailing !== null) window.clearTimeout(trailing);
      window.removeEventListener('resize', onWindowResize);
    };
  }, []);

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return undefined;
    }
    const handle = window.setTimeout(() => saveViewPreferences(preferences), SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [preferences]);

  const resizeRail = useCallback((width: number) => {
    const next = clampSidebarWidth(width, RAIL_WIDTH_RANGE, 0, window.innerWidth);
    setPreferences((current) =>
      current.railWidth === next ? current : { ...current, railWidth: next },
    );
  }, []);

  const resetRail = useCallback(() => {
    setPreferences((current) =>
      current.railWidth === null ? current : { ...current, railWidth: null },
    );
  }, []);

  const gridStyle = useMemo<CSSProperties>(() => {
    const style: Record<string, string> = {};
    if (preferences.railWidth !== null) {
      style['--workspace-rail-width'] = `${String(preferences.railWidth)}px`;
    }
    return style as CSSProperties;
  }, [preferences.railWidth]);

  return {
    gridStyle,
    rail: {
      width: railWidth,
      range: RAIL_WIDTH_RANGE,
      resize: resizeRail,
      reset: resetRail,
    },
  };
}
