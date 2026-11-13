import { useCallback, useMemo, useRef, useState } from 'react';
import {
  MultiLaneCanvas,
  type MultiLaneCanvasHandle,
  type MultiLaneLayout,
  solidLane,
  type LanePlugin,
} from '@waypoint/workspace-editor';

const LANE_PALETTE = ['#fee2e2', '#dbeafe', '#d1fae5', '#fef3c7', '#ede9fe', '#fce7f3'];

const HEADER_PALETTE = ['#b91c1c', '#1d4ed8', '#047857', '#b45309', '#6d28d9', '#be185d'];

function readUrlNumber(name: string, fallback: number): number {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readUrlHeights(): number[] {
  const raw = new URLSearchParams(window.location.search).get('lanes');
  if (!raw) return [30, 50, 40];
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function MultiLaneHarnessPage(): JSX.Element {
  const initialPx = useMemo(() => readUrlNumber('px', 4), []);
  const columnCount = useMemo(() => readUrlNumber('cols', 1000), []);
  const minGutterWidth = useMemo(() => readUrlNumber('gutter', 80), []);
  const heights = useMemo(() => readUrlHeights(), []);
  const [pxPerColumn, setPxPerColumn] = useState(initialPx);
  const handleRef = useRef<MultiLaneCanvasHandle | null>(null);

  const lanes = useMemo<readonly LanePlugin[]>(
    () =>
      heights.map((h, i) =>
        solidLane({
          id: `lane-${i}`,
          color: LANE_PALETTE[i % LANE_PALETTE.length],
          height: h,
          type: i === 0 ? 'reference' : i === heights.length - 1 ? 'consensus' : 'read',
          header: {
            width: 120,
            label: `lane ${i}`,
            textColor: HEADER_PALETTE[i % HEADER_PALETTE.length],
          },
        })
      ),
    [heights]
  );

  const onLayoutChange = useCallback((layout: MultiLaneLayout) => {
    const w = window as Window & { __multiLaneHarness?: Record<string, unknown> };
    if (!w.__multiLaneHarness) {
      w.__multiLaneHarness = {
        getLayout: () => handleRef.current?.getLayout() ?? null,
        scrollToLane: (id: string, align?: 'top' | 'center') =>
          handleRef.current?.scrollToLane(id, align),
        setScrollTop: (top: number) => handleRef.current?.setScrollTop(top),
        setPxPerColumn: (px: number) => setPxPerColumn(px),
        redraw: () => handleRef.current?.redraw(),
      };
    }
    (w.__multiLaneHarness as { layout?: MultiLaneLayout }).layout = layout;
  }, []);

  return (
    <div
      data-testid="multi-lane-harness"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#f8fafc',
      }}
    >
      <header
        style={{
          padding: '6px 12px',
          borderBottom: '1px solid #e2e8f0',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: 12,
          color: '#475569',
        }}
      >
        multi-lane harness · {heights.length} lanes · {columnCount} cols · px/col=
        {pxPerColumn.toFixed(2)}
      </header>
      <MultiLaneCanvas
        ref={handleRef}
        lanes={lanes}
        columnCount={columnCount}
        pxPerColumn={pxPerColumn}
        leftGutterWidth={minGutterWidth}
        onLayoutChange={onLayoutChange}
        style={{ flex: 1 }}
        testId="multi-lane-canvas"
      />
    </div>
  );
}
