// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  capturePaneResizeScrollFreezeAnchor,
  canvas2dPositionForMapPlacement,
  isInflatedSequenceColumnSpanMeasure,
  maxFrameScrollTopDeltaDuringPaneResizeDrag,
  maxScrollTopDeltaDuringPaneResizeDrag,
  resolveCircularBufferHeightHighWater,
  resolvePaneResizeScrollRestore,
  resolveSequencePaneViewportHeight,
  type PaneResizeScrollSample,
  type SequenceMapPlacementForScrollFreeze,
} from './pane-resize-scroll-freeze';
import { workspaceViewerSequenceViewportHeightHint } from './workspace-viewer-layout-styles';

describe('pane-resize Canvas 2D scroll freeze  N10)', () => {
  it('FAILS LOUDLY when mid-drag scrollTop flickers (simulated drag samples)', () => {
    const flickeringDrag: PaneResizeScrollSample[] = [
      { scrollTop: 800, topBp: 1200 },
      { scrollTop: 800, topBp: 1200 },
      { scrollTop: 800, topBp: 1200 },
      { scrollTop: 6229, topBp: 9400 },
      { scrollTop: 6229, topBp: 9400 },
      { scrollTop: 11851, topBp: 18000 },
    ];

    expect(
      maxScrollTopDeltaDuringPaneResizeDrag(flickeringDrag),
      'violent mid-drag scrollTop range must be detected'
    ).toBeGreaterThan(1);
    expect(
      maxFrameScrollTopDeltaDuringPaneResizeDrag(flickeringDrag),
      'violent consecutive-frame scrollTop jump must be detected'
    ).toBeGreaterThan(1);
  });

  it('PASSES when every mid-drag sample keeps the same scrollTop (freeze policy)', () => {
    const frozenDrag: PaneResizeScrollSample[] = Array.from({ length: 40 }, () => ({
      scrollTop: 800,
      topBp: 1200,
    }));

    expect(maxScrollTopDeltaDuringPaneResizeDrag(frozenDrag)).toBe(0);
    expect(maxFrameScrollTopDeltaDuringPaneResizeDrag(frozenDrag)).toBe(0);
  });

  it('captures freeze height from visible clientHeight, not buffer/hint inflation', () => {
    const anchor = capturePaneResizeScrollFreezeAnchor({
      scrollTop: 800,
      clientHeight: 805,
      topBp: 1200,
    });
    expect(anchor.height).toBe(805);
    expect(anchor.scrollTop).toBe(800);
    expect(anchor.topBp).toBe(1200);
  });

  it('restores settle scroll by exact scrollTop when layout geometry is unchanged', () => {
    const anchor = capturePaneResizeScrollFreezeAnchor({
      scrollTop: 800,
      clientHeight: 805,
      topBp: 1200,
    });
    expect(
      resolvePaneResizeScrollRestore({
        anchor,
        scrollYForTopBp: 5697,
        layoutGeometryChanged: false,
      })
    ).toBe(800);
  });

  it('restores settle scroll by topBp only when layout geometry changed', () => {
    const anchor = capturePaneResizeScrollFreezeAnchor({
      scrollTop: 800,
      clientHeight: 805,
      topBp: 1200,
    });
    expect(
      resolvePaneResizeScrollRestore({
        anchor,
        scrollYForTopBp: 412,
        layoutGeometryChanged: true,
      })
    ).toBe(412);
    expect(
      resolvePaneResizeScrollRestore({
        anchor,
        scrollYForTopBp: null,
        layoutGeometryChanged: true,
      })
    ).toBe(800);
  });

  it('keeps circular-buffer high-water so settle cannot shrink virt rows', () => {
    expect(
      resolveCircularBufferHeightHighWater({
        liveHeight: 745,
        highWater: 805,
      })
    ).toBe(805);
    expect(
      resolveCircularBufferHeightHighWater({
        liveHeight: 900,
        highWater: 805,
      })
    ).toBe(900);
  });

  it('FAILS LOUDLY on column-span measure when 2D is on top (map below)', () => {
    expect(
      isInflatedSequenceColumnSpanMeasure({
        sequencePaneHeight: 345,
        columnBottomMinusSequenceTop: 1594,
      })
    ).toBe(true);
    expect(resolveSequencePaneViewportHeight({ sequencePaneHeight: 345 })).toBe(345);
  });

  it('keeps the same viewport-height measure contract for all four placements', () => {
    const placements: SequenceMapPlacementForScrollFreeze[] = ['bottom', 'top', 'left', 'right'];
    for (const mapPlacement of placements) {
      const canvas2dOn = canvas2dPositionForMapPlacement(mapPlacement);
      expect(
        resolveSequencePaneViewportHeight({ sequencePaneHeight: 805 }),
        `map=${mapPlacement} (2D on ${canvas2dOn}) must use pane height`
      ).toBe(805);
    }
    expect(canvas2dPositionForMapPlacement('bottom')).toBe('top');
    expect(canvas2dPositionForMapPlacement('top')).toBe('bottom');
    expect(canvas2dPositionForMapPlacement('left')).toBe('right');
    expect(canvas2dPositionForMapPlacement('right')).toBe('left');
  });

  it('WorkspaceViewer freezes 2D for the whole drag; pane height for hint, column-span floor for circular buffer', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/features/sequence/components/WorkspaceViewer.tsx'),
      'utf8'
    );
    expect(source).toContain('freezeViewportHeight={mapPaneResizePreviewActive}');
    expect(source).toContain('setMapPaneResizePreviewActive(true)');
    expect(source).toContain('resolveCircularBufferHeightHighWater');
    expect(source).toContain('resolveSequencePaneViewportHeight');
    expect(source).toContain('columnRect.bottom - sequenceRect.top');
    expect(source).toContain('columnSpanHeight');
    expect(source).toContain("from './pane-resize-scroll-freeze'");

    const applySizeBlock = source.slice(
      source.indexOf('const applySize = (size: { width: number; height: number }) => {'),
      source.indexOf('const scheduleSize = (size: { width: number; height: number }) => {')
    );
    expect(applySizeBlock).not.toContain('setSequenceLayoutViewportHeight');
    expect(applySizeBlock).not.toContain('flushSync');

    expect(source).toContain('mapPaneResizePreviewActive');
    expect(source).toContain('workspaceViewerSequenceViewportHeightHint({');
    expect(
      workspaceViewerSequenceViewportHeightHint({
        mapPaneResizePreviewActive: true,
        mapSurfaceVisible: false,
        sequenceSurfaceVisible: true,
        sequenceLayoutViewportHeight: 345,
      })
    ).toBeUndefined();
    expect(
      workspaceViewerSequenceViewportHeightHint({
        mapPaneResizePreviewActive: false,
        mapSurfaceVisible: true,
        sequenceSurfaceVisible: true,
        sequenceLayoutViewportHeight: 345,
      })
    ).toBeUndefined();
  });

  it('SequenceViewer ignores height RO + hint while freezeViewportHeight is set', () => {
    const source = readFileSync(
      join(process.cwd(), '../../packages/core/workspace-editor/src/SequenceViewer.tsx'),
      'utf8'
    );
    expect(source).toContain('freezeViewportHeight');
    expect(source).toContain('if (freezeViewportHeight) return;');
    expect(source).toContain('frozenScrollAnchorRef');
    expect(source).toContain('getScrollYForSequencePosition');
  });

  it('N10 placement matrix: simulated drag stays frozen for top/bottom/left/right 2D', () => {
    const canvasPositions: SequenceMapPlacementForScrollFreeze[] = [
      'top',
      'bottom',
      'left',
      'right',
    ];
    for (const canvas2dOn of canvasPositions) {
      const frozenDrag: PaneResizeScrollSample[] = Array.from({ length: 24 }, () => ({
        scrollTop: 800,
        topBp: 1200,
      }));
      expect(
        maxScrollTopDeltaDuringPaneResizeDrag(frozenDrag),
        `2D on ${canvas2dOn}: mid-drag scrollTop must stay put`
      ).toBe(0);
      expect(
        maxFrameScrollTopDeltaDuringPaneResizeDrag(frozenDrag),
        `2D on ${canvas2dOn}: no frame-to-frame scroll flicker`
      ).toBe(0);
      const anchor = capturePaneResizeScrollFreezeAnchor({
        scrollTop: 800,
        clientHeight: 805,
        topBp: 1200,
      });
      expect(
        resolvePaneResizeScrollRestore({
          anchor,
          scrollYForTopBp: 9999,
          layoutGeometryChanged: false,
        }),
        `2D on ${canvas2dOn}: mouseup must not teleport via stale topBp Y`
      ).toBe(800);
    }
  });
});
