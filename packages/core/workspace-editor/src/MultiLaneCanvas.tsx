import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { computeMultiLaneLayout, type MultiLaneLayout } from './lanes/layout';
import { renderMultiLane, type RenderMultiLaneOptions } from './lanes/render';
import type { LanePlugin, MeasuredLane } from './lanes/types';

export interface MultiLaneCanvasProps {
  lanes: readonly LanePlugin[];
  columnCount: number;
  pxPerColumn: number;
  scrollLeft?: number;
  leftGutterWidth?: number;
  className?: string;
  style?: React.CSSProperties;
  renderOptions?: RenderMultiLaneOptions;
  onLayoutChange?: (layout: MultiLaneLayout) => void;
  testId?: string;
}

export interface MultiLaneCanvasHandle {
  getLayout(): MultiLaneLayout | null;
  scrollToLane(laneId: string, align?: 'top' | 'center'): void;
  setScrollTop(scrollTop: number): void;
  redraw(): void;
}

const DEFAULT_DPR = 1;

function readDevicePixelRatio(): number {
  if (typeof window === 'undefined') return DEFAULT_DPR;
  return Math.max(1, window.devicePixelRatio ?? DEFAULT_DPR);
}

export const MultiLaneCanvas = forwardRef<MultiLaneCanvasHandle, MultiLaneCanvasProps>(
  function MultiLaneCanvas(
    {
      lanes,
      columnCount,
      pxPerColumn,
      scrollLeft = 0,
      leftGutterWidth = 0,
      className,
      style,
      renderOptions,
      onLayoutChange,
      testId,
    },
    ref
  ): JSX.Element {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layoutRef = useRef<MultiLaneLayout | null>(null);
    const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
      width: 0,
      height: 0,
    });
    const [scrollTop, setScrollTop] = useState(0);

    const layout = useMemo(
      () =>
        computeMultiLaneLayout({
          columnCount,
          pxPerColumn,
          viewportWidth: viewportSize.width,
          viewportHeight: viewportSize.height,
          scrollLeft,
          scrollTop,
          leftGutterWidth,
          lanes,
        }),
      [
        columnCount,
        pxPerColumn,
        viewportSize.width,
        viewportSize.height,
        scrollLeft,
        scrollTop,
        leftGutterWidth,
        lanes,
      ]
    );

    layoutRef.current = layout;

    useEffect(() => {
      onLayoutChange?.(layout);
    }, [layout, onLayoutChange]);

    useLayoutEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const update = () => {
        const rect = el.getBoundingClientRect();
        setViewportSize((prev) =>
          prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height }
        );
      };
      update();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(update);
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const max = Math.max(0, layout.totalHeight - layout.viewportHeight);
      if (scrollTop > max) setScrollTop(max);
    }, [layout.totalHeight, layout.viewportHeight, scrollTop]);

    const draw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = readDevicePixelRatio();
      const w = Math.max(0, layout.viewportWidth);
      const h = Math.max(0, layout.viewportHeight);
      const targetW = Math.max(1, Math.round(w * dpr));
      const targetH = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== targetW) canvas.width = targetW;
      if (canvas.height !== targetH) canvas.height = targetH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderMultiLane(ctx, layout, {
        ...renderOptions,
        canvasWidth: w,
        canvasHeight: h,
      });
    }, [layout, renderOptions]);

    useEffect(() => {
      draw();
    }, [draw]);

    const onWheel = useCallback(
      (event: React.WheelEvent<HTMLDivElement>) => {
        if (!layout.requiresVerticalScroll) return;
        event.preventDefault();
        const max = Math.max(0, layout.totalHeight - layout.viewportHeight);
        setScrollTop((prev) => {
          const next = prev + event.deltaY;
          if (next < 0) return 0;
          if (next > max) return max;
          return next;
        });
      },
      [layout.requiresVerticalScroll, layout.totalHeight, layout.viewportHeight]
    );

    useImperativeHandle(
      ref,
      (): MultiLaneCanvasHandle => ({
        getLayout: () => layoutRef.current,
        scrollToLane: (laneId, align = 'top') => {
          const current = layoutRef.current;
          if (!current) return;
          const lane = current.lanes.find((l: MeasuredLane) => l.id === laneId);
          if (!lane) return;
          const max = Math.max(0, current.totalHeight - current.viewportHeight);
          const target =
            align === 'center'
              ? lane.y - Math.max(0, (current.viewportHeight - lane.height) / 2)
              : lane.y;
          setScrollTop(Math.max(0, Math.min(max, target)));
        },
        setScrollTop: (next: number) => {
          const current = layoutRef.current;
          const max = current ? Math.max(0, current.totalHeight - current.viewportHeight) : 0;
          setScrollTop(Math.max(0, Math.min(max, next)));
        },
        redraw: () => draw(),
      }),
      [draw]
    );

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ position: 'relative', overflow: 'hidden', ...style }}
        onWheel={onWheel}
        data-multilane-host="true"
      >
        <canvas
          ref={canvasRef}
          data-testid={testId ?? 'multi-lane-canvas'}
          style={{ display: 'block', width: '100%', height: '100%' }}
        />
      </div>
    );
  }
);
