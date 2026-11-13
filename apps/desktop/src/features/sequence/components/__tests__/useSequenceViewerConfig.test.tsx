/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import {
  computeScaledConfig,
  deriveSequenceLodLevel,
  resolveIndexedCdsZoomConfig,
} from '@waypoint/workspace-editor';
import { DEFAULT_SEQUENCE_VIEW_STATE } from '../../view-state/sequence-view-state';
import { useSequenceViewerConfig } from '../useSequenceViewerConfig';

describe('useSequenceViewerConfig', () => {
  it('retains sequence configuration during map camera and topology updates', () => {
    const input = {
      seqView: DEFAULT_SEQUENCE_VIEW_STATE,
      patchSeqView: vi.fn(),
      cutSitesVisible: false,
      toggleCutSitesVisibility: vi.fn(),
      viewerLodLevel: 'detail' as const,
      isDetailLod: true,
      isOverviewLod: false,
      aaColorScheme: 'rasmol',
      scaledViewerMetrics: { charWidth: 8, fontSize: 11, rowHeight: 20 },
    };
    const { result, rerender } = renderHook(useSequenceViewerConfig, { initialProps: input });
    const initial = result.current;
    rerender({
      ...input,
      seqView: {
        ...input.seqView,
        webglMorph: 0.5,
        webglCenterBp: 1000,
        centerBp: 1200,
        display: { ...input.seqView.display },
      },
    });
    expect(result.current.viewerConfig).toBe(initial.viewerConfig);
    expect(result.current.editorConfig).toBe(initial.editorConfig);
    rerender({ ...input, seqView: { ...input.seqView, zoom: 125 } });
    expect(result.current.viewerConfig.zoomLevel).toBe(125);
    expect(result.current.editorConfig).not.toBe(initial.editorConfig);
  });

  it('publishes indexed zoom inputs and hands the actual pane width to the shared policy', () => {
    for (const zoom of [4.8, 10, 32, 34]) {
      const scaledViewerMetrics = computeScaledConfig(
        { charWidth: 8, fontSize: 11, rowHeight: 20 },
        zoom
      );
      const viewerLodLevel = deriveSequenceLodLevel(scaledViewerMetrics);
      const { result, unmount } = renderHook(() =>
        useSequenceViewerConfig({
          seqView: { ...DEFAULT_SEQUENCE_VIEW_STATE, zoom },
          patchSeqView: vi.fn(),
          cutSitesVisible: false,
          toggleCutSitesVisibility: vi.fn(),
          viewerLodLevel,
          isDetailLod: viewerLodLevel === 'detail',
          isOverviewLod: false,
          hideReverseComplement: false,
          aaColorScheme: 'rasmol',
          scaledViewerMetrics,
        })
      );
      const mounted = {
        ...result.current.editorConfig,
        ...resolveIndexedCdsZoomConfig(result.current.editorConfig, 1342),
      };
      const expected = cdsReplacementZoomPresentation(scaledViewerMetrics.charWidth, 1342);
      expect(mounted.cdsZoomPresentation).toEqual(expected);
      expect(mounted.cdsDetailProgress).toBe(expected.progress);
      expect(mounted.showNucleotideLetters).toBe(false);
      expect(mounted.showReverseComplement).toBe(false);
      if (zoom === 4.8) expect(mounted.cdsZoomPresentation.colorAlpha).toBe(0);
      else expect(mounted.cdsZoomPresentation.colorAlpha).toBe(1);
      expect(mounted.cdsZoomPresentation.residueAlpha).toBe(zoom < 34 ? 0 : 1);
      unmount();
    }
  });
  it('derives toolbar/editor config from sequence view state and LOD', () => {
    const { result } = renderHook(() =>
      useSequenceViewerConfig({
        seqView: {
          ...DEFAULT_SEQUENCE_VIEW_STATE,
          zoom: 125,
          display: {
            showAnnotations: true,
            showTranslation: true,
            showReverseComplement: true,
            showPrimers: true,
            showResidueNumbers: true,
          },
          annotationColorMode: 'manual',
        },
        patchSeqView: vi.fn(),
        cutSitesVisible: true,
        toggleCutSitesVisibility: vi.fn(),
        viewerLodLevel: 'feature',
        isDetailLod: false,
        isOverviewLod: false,
        hideReverseComplement: false,
        aaColorScheme: 'rasmol',
        scaledViewerMetrics: { charWidth: 5, fontSize: 8, rowHeight: 12 },
      })
    );

    expect(result.current.viewerConfig).toMatchObject({
      zoomLevel: 125,
      showCutSites: true,
      annotationColorMode: 'manual',
    });
    expect(result.current.editorConfig).toMatchObject({
      lodLevel: 'feature',
      showTranslation: true,
      showReverseComplement: false,
      showPrimers: true,
      showResidueNumbers: false,
      charWidth: 5,
      fontSize: 8,
      rowHeight: 12,
      aaColorScheme: 'rasmol',
    });
  });

  it('routes toolbar writes through cut-site persistence and sequence view state', () => {
    const patchSeqView = vi.fn();
    const toggleCutSitesVisibility = vi.fn();
    const { result } = renderHook(() =>
      useSequenceViewerConfig({
        seqView: DEFAULT_SEQUENCE_VIEW_STATE,
        patchSeqView,
        cutSitesVisible: false,
        toggleCutSitesVisibility,
        viewerLodLevel: 'detail',
        isDetailLod: true,
        isOverviewLod: false,
        hideReverseComplement: false,
        aaColorScheme: 'rasmol',
        scaledViewerMetrics: { charWidth: 9, fontSize: 14, rowHeight: 20 },
      })
    );

    act(() => {
      result.current.handleConfigChange({
        ...result.current.viewerConfig,
        showCutSites: true,
        zoomLevel: 80,
        showPrimers: false,
      });
    });

    expect(toggleCutSitesVisibility).toHaveBeenCalledTimes(1);
    expect(patchSeqView).toHaveBeenCalledWith({
      zoom: 80,
      annotationColorMode: DEFAULT_SEQUENCE_VIEW_STATE.annotationColorMode,
      display: {
        showAnnotations: DEFAULT_SEQUENCE_VIEW_STATE.display.showAnnotations,
        showTranslation: DEFAULT_SEQUENCE_VIEW_STATE.display.showTranslation,
        showReverseComplement: DEFAULT_SEQUENCE_VIEW_STATE.display.showReverseComplement,
        showPrimers: false,
        showResidueNumbers: DEFAULT_SEQUENCE_VIEW_STATE.display.showResidueNumbers,
      },
    });
  });

  it('prepares complement space without an empty translation band below the readable-font threshold', () => {
    const { result } = renderHook(() =>
      useSequenceViewerConfig({
        seqView: DEFAULT_SEQUENCE_VIEW_STATE,
        patchSeqView: vi.fn(),
        cutSitesVisible: false,
        toggleCutSitesVisibility: vi.fn(),
        viewerLodLevel: 'feature',
        isDetailLod: false,
        isOverviewLod: false,
        hideReverseComplement: false,
        aaColorScheme: 'rasmol',
        scaledViewerMetrics: { charWidth: 3.48, fontSize: 4.785, rowHeight: 8.7 },
      })
    );
    expect(result.current.editorConfig.showTranslation).toBe(true);
    expect(result.current.editorConfig.showReverseComplement).toBe(false);
    expect(result.current.editorConfig.previewDetailTracks).toEqual({
      progress: 1,
      showTranslation: false,
      showReverseComplement: true,
      showResidueNumbers: false,
    });
  });
  it('finishes label lift before continuous pane-density color replacement', () => {
    const phases: number[] = [];
    const bandPhases: number[] = [];
    const onsetZoom = ((1342 + 256) / 3000 / 8) * 100;
    for (const zoom of [
      0.2,
      5.3,
      6,
      onsetZoom - 0.2,
      onsetZoom + 0.001,
      onsetZoom * 1.1,
      onsetZoom * 1.2,
      onsetZoom * 1.25,
      32,
      34,
      100,
    ]) {
      const scaledViewerMetrics = computeScaledConfig(
        { charWidth: 8, fontSize: 11, rowHeight: 20 },
        zoom
      );
      const viewerLodLevel = deriveSequenceLodLevel(scaledViewerMetrics);
      const detail = viewerLodLevel === 'detail';
      const { result, unmount } = renderHook(() =>
        useSequenceViewerConfig({
          seqView: { ...DEFAULT_SEQUENCE_VIEW_STATE, zoom },
          patchSeqView: vi.fn(),
          cutSitesVisible: false,
          toggleCutSitesVisibility: vi.fn(),
          viewerLodLevel,
          isDetailLod: detail,
          isOverviewLod: false,
          hideReverseComplement: false,
          aaColorScheme: 'rasmol',
          scaledViewerMetrics,
        })
      );
      const mounted = {
        ...result.current.editorConfig,
        ...resolveIndexedCdsZoomConfig(result.current.editorConfig, 1342),
      };
      phases.push(mounted.cdsDetailProgress);
      bandPhases.push(mounted.cdsZoomPresentation.bandProgress);
      expect(mounted.cdsZoomPresentation.colorAlpha).toBe(mounted.cdsDetailProgress);
      expect(mounted.cdsZoomPresentation.bandProgress).toBeGreaterThanOrEqual(
        mounted.cdsDetailProgress
      );
      if (zoom === 5.3) {
        expect(mounted.cdsZoomPresentation.bandProgress).toBeGreaterThan(0);
        expect(mounted.cdsZoomPresentation.bandProgress).toBeLessThan(1);
        expect(mounted.cdsZoomPresentation.colorAlpha).toBe(0);
      }
      if (zoom === 6) {
        expect(mounted.cdsZoomPresentation.bandProgress).toBe(1);
        expect(mounted.cdsZoomPresentation.colorAlpha).toBe(0);
        expect(mounted.cdsZoomPresentation.residueAlpha).toBe(0);
      }
      expect(mounted.cdsZoomPresentation.barHeight).toBe(mounted.cdsZoomPresentation.aaHeight);
      expect(mounted.showTranslation).toBe(true);
      if (mounted.cdsDetailProgress === 0) expect(mounted.cdsZoomPresentation?.barHeight).toBe(14);
      expect(result.current.editorConfig.previewDetailTracks?.showTranslation ?? false).toBe(false);
      unmount();
    }
    expect(bandPhases[0]).toBe(0);
    for (let index = 1; index < phases.length; index += 1) {
      expect(bandPhases[index]).toBeGreaterThanOrEqual(bandPhases[index - 1]);
      expect(phases[index]).toBeGreaterThanOrEqual(phases[index - 1]);
    }
    expect(phases.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(phases[4]).toBeGreaterThan(0);
    expect(phases[4]).toBeLessThan(0.001);
    expect(phases[5]).toBeGreaterThan(phases[4]);
    expect(phases[6]).toBeGreaterThan(phases[5]);
    expect(phases.slice(7)).toEqual([1, 1, 1, 1]);
  });
});
