// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCompositorStretchPlan,
  isDrawAspectMismatchPlan,
  resolvePaneResizeDisplaySize,
  resolveSequencePaneHeightDuringMapResize,
} from './pane-resize-display-size';

describe('pane-resize display size — stretch invariants ', () => {
  it('FAILS LOUDLY on the classic compositor-stretch plan (CSS live, backing max)', () => {
    const classicStretchPlan = {
      cssWidth: 700,
      cssHeight: 350,
      backingWidth: 1400,
      backingHeight: 900,
    };
    expect(
      isCompositorStretchPlan(classicStretchPlan),
      'classic CSS-live/backing-max plan must be detected as compositor stretch'
    ).toBe(true);
  });

  it('FAILS LOUDLY on the draw-aspect oval plan (CSS/backing max, state live)', () => {
    const ovalPlan = {
      cssWidth: 1370,
      cssHeight: 881,
      width: 1370,
      height: 350,
    };
    expect(
      isDrawAspectMismatchPlan(ovalPlan),
      'CSS/backing max with live state height must be detected as draw-aspect mismatch'
    ).toBe(true);
  });

  it('live-locks CSS, backing, and state so neither stretch mode can fire', () => {
    const plan = resolvePaneResizeDisplaySize({
      liveWidth: 1370,
      liveHeight: 350,
      geometryHeight: 491,
      morph: 0,
    });

    expect(plan).toMatchObject({
      width: 1370,
      height: 350,
      backingWidth: 1370,
      backingHeight: 350,
      cssWidth: 1370,
      cssHeight: 350,
      immediate: true,
    });
    expect(isCompositorStretchPlan(plan)).toBe(false);
    expect(isDrawAspectMismatchPlan(plan)).toBe(false);
  });

  it('never returns a preview-max pin for width or height', () => {
    const previewMax = { width: 1400, height: 900 };
    const live = { width: 720, height: 340 };
    const plan = resolvePaneResizeDisplaySize({
      liveWidth: live.width,
      liveHeight: live.height,
      geometryHeight: 491,
      morph: 1,
    });

    expect(plan.backingWidth).not.toBe(previewMax.width);
    expect(plan.backingHeight).not.toBe(previewMax.height);
    expect(plan.cssWidth).toBe(live.width);
    expect(plan.cssHeight).toBe(live.height);
    expect(plan.width).toBe(live.width);
    expect(plan.height).toBe(live.height);
  });

  it('keeps horizontal shrink live-locked (side-by-side divider)', () => {
    const plan = resolvePaneResizeDisplaySize({
      liveWidth: 640,
      liveHeight: 981,
      geometryHeight: 600,
      morph: 1,
    });
    expect(isCompositorStretchPlan(plan)).toBe(false);
    expect(isDrawAspectMismatchPlan(plan)).toBe(false);
    expect(plan.cssWidth).toBe(640);
    expect(plan.backingWidth).toBe(640);
    expect(plan.width).toBe(640);
  });

  it('WorkspaceViewer wires the live-lock helper (no preview-max CSS/backing pin)', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/features/sequence/components/WorkspaceViewer.tsx'),
      'utf8'
    );
    expect(source).toContain('resolvePaneResizeDisplaySize');
    expect(source).not.toContain('cssWidth: preview ? previewBackingWidth');
    expect(source).not.toContain('cssHeight: preview ? previewBackingHeight');
    expect(source).not.toContain('backingWidth: preview ? previewBackingWidth');
    expect(source).not.toContain('backingHeight: preview ? previewBackingHeight');
    expect(source).not.toContain('immediate: preview ? false : true');
  });

  it('FAILS LOUDLY if Canvas 2D height is live-updated during map-pane applySize', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/features/sequence/components/WorkspaceViewer.tsx'),
      'utf8'
    );
    expect(source).toContain('freezeViewportHeight={mapPaneResizePreviewActive}');
    expect(source).toContain('setMapPaneResizePreviewActive(true)');
    expect(source).toContain('resolveSequencePaneHeightDuringMapResize');
    const applySizeBlock = source.slice(
      source.indexOf('const applySize = (size: { width: number; height: number }) => {'),
      source.indexOf('const scheduleSize = (size: { width: number; height: number }) => {')
    );
    expect(applySizeBlock).not.toContain('setSequenceLayoutViewportHeight');
    expect(applySizeBlock).not.toContain('flushSync');
    const mouseUpBlock = source.slice(
      source.indexOf('const handleMouseUp = () => {'),
      source.indexOf("document.addEventListener('mousemove', handleMouseMove);")
    );
    expect(mouseUpBlock).toContain('resolveSequencePaneHeightDuringMapResize');
    expect(mouseUpBlock).toContain('setSequenceLayoutViewportHeight');
    expect(mouseUpBlock).toContain('resolveCircularBufferHeightHighWater');
    expect(mouseUpBlock).not.toContain('savedScrollTop');
  });

  it('computes settled sequence pane height from layout math (mouseup only)', () => {
    expect(
      resolveSequencePaneHeightDuringMapResize({
        layoutHeight: 1000,
        mapHeight: 300,
        handleHeight: 6,
        minSequenceHeight: 96,
      })
    ).toBe(694);

    expect(
      resolveSequencePaneHeightDuringMapResize({
        layoutHeight: 1000,
        mapHeight: 500,
        handleHeight: 6,
        minSequenceHeight: 96,
      })
    ).toBe(494);

    expect(
      resolveSequencePaneHeightDuringMapResize({
        layoutHeight: 400,
        mapHeight: 350,
        handleHeight: 6,
        minSequenceHeight: 96,
      })
    ).toBe(96);
  });
});
