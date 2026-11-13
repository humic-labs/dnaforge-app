// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { webglThemeForMode } from '../shared/theme';
import type { TrackPaintArgs } from './types';
import type { QuantitativeTrackData } from './quantitative-track-renderer';
import type {
  QuantitativeSourceSummaryV1,
  QuantitativeTrackPresentationV1,
} from '@waypoint/genome-data';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      fillStyle: '',
      fillRect: () => undefined,
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

const CHROMOSOME = {
  id: 'chr1',
  displayName: 'chr1',
  length: 248_956_422,
  cytobands: [],
};

const NO_SMOOTHING: QuantitativeTrackPresentationV1 = {
  version: 1,
  graph: 'bar',
  showRange: true,
  smoothingSigmaBins: 0,
  scale: { mode: 'robust-global', transform: 'linear' },
};

function paintArgs(
  container: TrackPaintArgs<QuantitativeTrackData>['container'],
  records: QuantitativeTrackData['records'],
  displayColor?: string,
  quantitative?: QuantitativeTrackPresentationV1,
  quantitativeSourceSummary?: QuantitativeSourceSummaryV1
): TrackPaintArgs<QuantitativeTrackData> {
  return {
    container,
    data: { records },
    presentation: { color: displayColor, quantitative, quantitativeSourceSummary },
    chromosome: CHROMOSOME,
    pathMapper: {
      pixelsPerBp: 2,
      bpLeftX: (bp: number) => (bp - 900) * 2,
    },
    viewportBpRange: { start: 900, end: 1_300 },
    viewportWidthPx: 800,
    viewportHeightPx: 600,
    layoutEntry: {
      id: 'bigwig-signal',
      top: 100,
      height: 80,
      contentClipped: false,
      hidden: false,
    },
    containerTopPx: 100,
    theme: webglThemeForMode('light'),
  } as unknown as TrackPaintArgs<QuantitativeTrackData>;
}

describe('PixiQuantitativeTrackRenderer', () => {
  it('turns signed BigWig values into a visible retained signal mesh', async () => {
    const { PixiQuantitativeTrackRenderer } = await import('./quantitative-track-renderer');
    const renderer = new PixiQuantitativeTrackRenderer({
      type: 'bigwig-signal',
      mode: 'signal',
    });
    const container = renderer.mount({
      chromosome: CHROMOSOME,
      theme: webglThemeForMode('light'),
    });

    renderer.paint(
      paintArgs(
        container,
        [
          { chrom: 'chr1', start: 1_000, end: 1_050, value: -2 },
          { chrom: 'chr1', start: 1_050, end: 1_100, value: 5 },
        ],
        undefined,
        NO_SMOOTHING
      )
    );

    expect(container.children).toHaveLength(1);
    expect(container.children[0]?.visible).toBe(true);
    expect(renderer.getDiagnostics(container)).toEqual({
      mode: 'signal',
      surfaceKind: 'continuous-fill',
      recordCount: 2,
      barCount: 2,
      minValue: -2,
      maxValue: 5,
      minRecordSpanBp: 50,
      maxRecordSpanBp: 50,
      maxRecordWidthPx: 100,
      displayColor: null,
      geometryBuildCount: 1,
      smoothingSigmaBins: 0,
      subpixelMinWidthPx: 0,
      subpixelMinAlphaScale: 1,
      scaleMode: 'robust-global',
      scaleTransform: 'linear',
      scaleSource: 'visible-fallback',
      displayMin: -2,
      displayMax: 5,
      clippedLowCount: 0,
      clippedHighCount: 0,
      clippedMarkerStyle: 'same-hue-cap',
      clippedMarkerThicknessPx: 2,
      rangeError: null,
    });

    renderer.paint(paintArgs(container, []));
    expect(container.children[0]?.visible).toBe(false);
  });

  it('keeps the robust whole-track scale stable and reports a clipped spike', async () => {
    const { PixiQuantitativeTrackRenderer } = await import('./quantitative-track-renderer');
    const renderer = new PixiQuantitativeTrackRenderer({
      type: 'bigwig-signal',
      mode: 'signal',
    });
    const container = renderer.mount({
      chromosome: CHROMOSOME,
      theme: webglThemeForMode('light'),
    });
    const summary: QuantitativeSourceSummaryV1 = {
      contract: 'dnaforge.quantitative-source-summary.v1',
      algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
      targetSampleCount: 65_536,
      sampleCount: 20_000,
      lowerQuantile: 0.005,
      upperQuantile: 0.995,
      robustMin: 0,
      robustMax: 12,
      fullMin: 0,
      fullMax: 10_000,
      missingData: 'excluded',
    };
    const records = [
      { chrom: 'chr1', start: 1_000, end: 1_050, value: 4 },
      { chrom: 'chr1', start: 1_050, end: 1_100, value: 10_000 },
    ];

    renderer.paint(paintArgs(container, records, undefined, NO_SMOOTHING, summary));
    expect(renderer.getDiagnostics(container)).toMatchObject({
      scaleMode: 'robust-global',
      scaleSource: 'source-robust',
      displayMin: 0,
      displayMax: 12,
      clippedHighCount: 1,
      rangeError: null,
    });

    renderer.paint(
      paintArgs(
        container,
        records,
        undefined,
        {
          version: 1,
          graph: 'bar',
          showRange: true,
          smoothingSigmaBins: 0,
          scale: { mode: 'full-global', transform: 'log1p' },
        },
        summary
      )
    );
    expect(renderer.getDiagnostics(container)).toMatchObject({
      scaleMode: 'full-global',
      scaleTransform: 'log1p',
      scaleSource: 'source-full',
      displayMax: 10_000,
      clippedHighCount: 0,
    });
  });

  it('uses streamed halo bins for geometry without leaking them into visible-window scaling', async () => {
    const { PixiQuantitativeTrackRenderer } = await import('./quantitative-track-renderer');
    const renderer = new PixiQuantitativeTrackRenderer({
      type: 'bigwig-signal',
      mode: 'signal',
    });
    const container = renderer.mount({
      chromosome: CHROMOSOME,
      theme: webglThemeForMode('light'),
    });

    const records = [
      { chrom: 'chr1', start: 800, end: 900, value: 1_000 },
      { chrom: 'chr1', start: 900, end: 1_000, value: 2 },
      { chrom: 'chr1', start: 1_200, end: 1_300, value: 4 },
      { chrom: 'chr1', start: 1_300, end: 1_400, value: 2_000 },
    ];
    const presentation: QuantitativeTrackPresentationV1 = {
      version: 1,
      graph: 'bar',
      showRange: true,
      smoothingSigmaBins: 0,
      scale: { mode: 'visible-window', transform: 'linear' },
    };
    renderer.paint(paintArgs(container, records, undefined, presentation));

    const flatMap = vi.spyOn(Array.prototype, 'flatMap');
    try {
      renderer.paint(paintArgs(container, records, undefined, presentation));
      expect(flatMap).not.toHaveBeenCalled();
    } finally {
      flatMap.mockRestore();
    }

    expect(renderer.getDiagnostics(container)).toMatchObject({
      recordCount: 4,
      scaleSource: 'visible',
      displayMin: 0,
      displayMax: 4,
      clippedHighCount: 0,
    });
  });

  it('marks clipped endpoints with a thin darker cap derived from the track color', async () => {
    const { PixiQuantitativeTrackRenderer } = await import('./quantitative-track-renderer');
    const renderer = new PixiQuantitativeTrackRenderer({
      type: 'bigwig-signal',
      mode: 'signal',
    });
    const container = renderer.mount({
      chromosome: CHROMOSOME,
      theme: webglThemeForMode('light'),
    });
    const mesh = container.children[0] as unknown as {
      shader?: { glProgram?: { fragment?: string; vertex?: string } };
    };
    const fragmentShader = mesh.shader?.glProgram?.fragment ?? '';
    const vertexShader = mesh.shader?.glProgram?.vertex ?? '';

    expect(vertexShader).toContain('varying float vEndpointY;');
    expect(vertexShader).toContain('varying float vScreenY;');
    expect(fragmentShader).toContain('abs(vScreenY - vEndpointY)');
    expect(fragmentShader).toContain('1.0 - smoothstep(1.0, 2.0, endpointDistancePx)');
    expect(fragmentShader).toContain('vColor.rgb * 0.62');
    expect(fragmentShader).not.toContain('vec4(0.96, 0.52, 0.08, 1.0)');
  });

  it('recolors retained signal geometry through a uniform without rebuilding it', async () => {
    const { PixiQuantitativeTrackRenderer } = await import('./quantitative-track-renderer');
    const renderer = new PixiQuantitativeTrackRenderer({
      type: 'bigwig-signal',
      mode: 'signal',
    });
    const container = renderer.mount({
      chromosome: CHROMOSOME,
      theme: webglThemeForMode('light'),
    });
    const records = [{ chrom: 'chr1', start: 1_000, end: 1_050, value: 42 }];

    renderer.paint(paintArgs(container, records, '#2563eb'));
    expect(renderer.getDiagnostics(container)).toMatchObject({
      displayColor: '#2563eb',
      geometryBuildCount: 1,
      recordCount: 1,
    });

    renderer.paint(paintArgs(container, records, '#e11d48'));
    expect(renderer.getDiagnostics(container)).toMatchObject({
      displayColor: '#e11d48',
      geometryBuildCount: 1,
      recordCount: 1,
    });
  });

  it('rebuilds signal geometry when Gaussian smoothing strength changes', async () => {
    const { PixiQuantitativeTrackRenderer } = await import('./quantitative-track-renderer');
    const renderer = new PixiQuantitativeTrackRenderer({
      type: 'bigwig-signal',
      mode: 'signal',
    });
    const container = renderer.mount({
      chromosome: CHROMOSOME,
      theme: webglThemeForMode('light'),
    });
    const records = [
      { chrom: 'chr1', start: 1_000, end: 1_050, value: 0 },
      { chrom: 'chr1', start: 1_050, end: 1_100, value: 10 },
      { chrom: 'chr1', start: 1_100, end: 1_150, value: 0 },
    ];

    renderer.paint(paintArgs(container, records));
    renderer.paint(
      paintArgs(container, records, undefined, {
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothingSigmaBins: 1.2,
        scale: { mode: 'visible-window', transform: 'linear' },
      })
    );

    expect(renderer.getDiagnostics(container)).toMatchObject({
      geometryBuildCount: 2,
      smoothingSigmaBins: 1.2,
      scaleSource: 'visible',
      displayMax: expect.closeTo(4.1437, 4),
      rangeError: null,
    });
  });
});
