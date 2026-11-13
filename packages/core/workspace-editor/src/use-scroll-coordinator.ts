import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { SequenceLayout } from './types';
import { getScrollYForSequencePosition } from './layout-utils';

export type ScrollReason =
  | 'zoom'
  | 'user-scroll'
  | 'center-preserve'
  | 'minimap'
  | 'auto-scroll'
  | 'prop-driven'
  | 'circular-wrap'
  | 'mutation-track'
  | 'tab-restore';

export interface UseScrollCoordinatorOpts {
  containerRef: RefObject<HTMLElement | null>;
  layout: SequenceLayout | null;
  getAnchorY?: (targetBp: number, layout: SequenceLayout) => number | null;
  onDropped?: (reason: ScrollReason, targetTopBp: number) => void;
}

export type ScrollPlacement = 'top' | 'center' | 'anchor';

export interface ScrollToBpOptions {
  placement?: ScrollPlacement;
  anchorOffsetPx?: number;
}

export interface ScrollCoordinator {
  isZooming(): boolean;
  setZooming(v: boolean): void;
  setScrollToBp(targetBp: number, reason: ScrollReason, opts?: ScrollToBpOptions): boolean;
}

function reasonAppliesDuringZoom(reason: ScrollReason): boolean {
  return reason === 'zoom' || reason === 'user-scroll';
}

export function useScrollCoordinator(opts: UseScrollCoordinatorOpts): ScrollCoordinator {
  const isZoomingRef = useRef(false);
  const layoutRef = useRef(opts.layout);
  layoutRef.current = opts.layout;
  const getAnchorYRef = useRef(opts.getAnchorY);
  getAnchorYRef.current = opts.getAnchorY;
  const onDroppedRef = useRef(opts.onDropped);
  onDroppedRef.current = opts.onDropped;
  const containerRefRef = useRef(opts.containerRef);
  containerRefRef.current = opts.containerRef;

  const isZooming = useCallback(() => isZoomingRef.current, []);

  const setZooming = useCallback((v: boolean) => {
    isZoomingRef.current = v;
  }, []);

  const setScrollToBp = useCallback(
    (targetBp: number, reason: ScrollReason, opts?: ScrollToBpOptions) => {
      const zooming = isZoomingRef.current;
      if (zooming && !reasonAppliesDuringZoom(reason)) {
        onDroppedRef.current?.(reason, targetBp);
        return false;
      }
      const container = containerRefRef.current.current;
      if (!container) return false;
      const layout = layoutRef.current;
      if (!layout) return false;
      const placement = opts?.placement ?? 'top';
      const rowY =
        placement === 'anchor' && getAnchorYRef.current
          ? getAnchorYRef.current(targetBp, layout)
          : getScrollYForSequencePosition(targetBp, layout, true);
      if (rowY === null) return false;
      const targetPx =
        placement === 'center'
          ? Math.max(0, rowY - container.clientHeight / 2)
          : placement === 'anchor'
            ? Math.max(0, rowY - (opts?.anchorOffsetPx ?? 0))
            : rowY;
      if (Math.abs(container.scrollTop - targetPx) < 0.5) return false;
      container.scrollTop = targetPx;
      return true;
    },
    []
  );

  useEffect(() => {
    return () => {
      isZoomingRef.current = false;
    };
  }, []);

  return { isZooming, setZooming, setScrollToBp };
}
