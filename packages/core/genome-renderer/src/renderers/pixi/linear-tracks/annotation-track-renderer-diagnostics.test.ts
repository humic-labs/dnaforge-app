// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';

import type { AnnotationRecord } from '@waypoint/genome-data';

import { webglThemeForMode } from '../shared/theme';
import type { TrackPaintArgs } from './types';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: () => undefined,
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

describe('PixiAnnotationTrackRenderer.getDiagnostics — Phase 6 surface', () => {
  it('mounts no legacy in-canvas text and measures occupied rows from shared presentation', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({ type: 'annotation-test' });
    const container = renderer.mount({
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
      theme: webglThemeForMode('light'),
    });
    const records: AnnotationRecord[] = [
      { chrom: 'chr1', start: 100, end: 200 },
      { chrom: 'chr1', start: 300, end: 400 },
    ];

    expect(container.children).toHaveLength(0);
    expect(
      renderer.measureContentHeight?.({
        data: { records },
        presentation: { rowHeightPx: 8, maxRows: 32 },
        chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
      })
    ).toBe(8);
  });

  it('recolors retained annotation geometry through shared presentation metadata', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({ type: 'annotation-test' });
    const chromosome = {
      id: 'chr1',
      displayName: 'chr1',
      length: 1_000_000,
      cytobands: [],
    };
    const container = renderer.mount({ chromosome, theme: webglThemeForMode('light') });
    const records: AnnotationRecord[] = [{ chrom: 'chr1', start: 100, end: 200 }];
    const paint = (color: string): void =>
      renderer.paint({
        container,
        data: { records },
        presentation: { color, rowHeightPx: 8, maxRows: 32 },
        chromosome,
        pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
        viewportBpRange: { start: 0, end: 1_000 },
        viewportWidthPx: 1_000,
        viewportHeightPx: 600,
        layoutEntry: {
          id: 'annotation-test',
          top: 0,
          height: 18,
          contentClipped: false,
          hidden: false,
        },
        containerTopPx: 0,
        theme: webglThemeForMode('light'),
      } as unknown as TrackPaintArgs<{ records: ReadonlyArray<AnnotationRecord> }>);

    paint('#2563eb');
    expect(renderer.getDiagnostics(container)).toMatchObject({
      displayColor: '#2563eb',
      geometryBuildCount: 1,
    });
    paint('#e11d48');
    expect(renderer.getDiagnostics(container)).toMatchObject({
      displayColor: '#e11d48',
      geometryBuildCount: 1,
    });
  });

  it('renders a hard-capped set of directional labels inside interval bars', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({ type: 'annotation-test', maxLabels: 2 });
    const chromosome = {
      id: 'chr1',
      displayName: 'chr1',
      length: 1_000,
      cytobands: [],
    };
    const container = renderer.mount({ chromosome, theme: webglThemeForMode('light') });
    const records: AnnotationRecord[] = [
      { chrom: 'chr1', start: 10, end: 120, name: 'first', strand: '+' },
      { chrom: 'chr1', start: 140, end: 260, name: 'second', strand: '-' },
      { chrom: 'chr1', start: 280, end: 400, name: 'third', strand: '+' },
    ];

    renderer.paint({
      container,
      data: { records },
      presentation: { rowHeightPx: 10, maxRows: 32 },
      chromosome,
      pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
      viewportBpRange: { start: 0, end: 1_000 },
      viewportWidthPx: 1_000,
      viewportHeightPx: 600,
      layoutEntry: {
        id: 'annotation-test',
        top: 0,
        height: 20,
        contentClipped: false,
        hidden: false,
      },
      containerTopPx: 0,
      theme: webglThemeForMode('light'),
    } as unknown as TrackPaintArgs<{ records: ReadonlyArray<AnnotationRecord> }>);

    expect(renderer.getDiagnostics(container)).toMatchObject({
      labelCount: 2,
      labelLimit: 2,
    });
    const renderedText = container.children.flatMap((child) =>
      'children' in child
        ? child.children.flatMap((grandchild) =>
            'text' in grandchild && grandchild.visible ? [String(grandchild.text)] : []
          )
        : []
    );
    expect(renderedText).toEqual(['first →', '← second']);
  });

  it('keeps DisplayObject alpha out of RGB tint saturation in the shared bar shader', async () => {
    const { ANNOTATION_VERTEX_SHADER } = await import('./annotation-track-renderer');
    expect(ANNOTATION_VERTEX_SHADER).toContain('uColor.rgb / uColor.a');
    expect(ANNOTATION_VERTEX_SHADER).toContain('mix(aColor.rgb, uTrackColor');
    expect(ANNOTATION_VERTEX_SHADER).toContain('featureRgb * tint');
    expect(ANNOTATION_VERTEX_SHADER).toContain('aColor.a * uColor.a');
    expect(ANNOTATION_VERTEX_SHADER).not.toContain('vColor = aColor * uColor');
    expect(ANNOTATION_VERTEX_SHADER).not.toContain('aColor.rgb * uColor.rgb');
  });

  it('returns null for a container the renderer never mounted', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const { Container } = await import('pixi.js');
    const renderer = new PixiAnnotationTrackRenderer({
      type: 'annotation-test',
    });
    expect(renderer.getDiagnostics(new Container())).toBeNull();
  });

  it('reports zero state for a mounted track with no data painted yet', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({
      type: 'annotation-test',
    });
    const container = renderer.mount({
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
      theme: webglThemeForMode('light'),
    });
    const diag = renderer.getDiagnostics(container);
    expect(diag).not.toBeNull();
    expect(diag!.recordCount).toBe(0);
    expect(diag!.visibleRecordCount).toBe(0);
    expect(diag!.droppedRecordCount).toBe(0);
    expect(diag!.lanesUsed).toBe(0);
    expect(diag!.maxLanes).toBe(32);
    expect(diag!.overflow).toBe(false);
    expect(diag!.utilizationFraction).toBe(0);
  });

  it('uses common presentation metadata instead of constructor-only row settings', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({
      type: 'annotation-test',
    });
    const container = renderer.mount({
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
      theme: webglThemeForMode('light'),
    });
    renderer.paint({
      container,
      data: { records: [] },
      presentation: { maxRows: 8, rowHeightPx: 6 },
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
    } as unknown as TrackPaintArgs<{ records: ReadonlyArray<AnnotationRecord> }>);
    expect(renderer.getDiagnostics(container)!.maxLanes).toBe(8);
  });

  it('null after unmount — disposed containers do not leak diagnostics', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({
      type: 'annotation-test',
    });
    const container = renderer.mount({
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
      theme: webglThemeForMode('light'),
    });
    renderer.unmount(container);
    expect(renderer.getDiagnostics(container)).toBeNull();
  });
});

describe('PixiAnnotationTrackRenderer.getDiagnostics — overflow detection', () => {
  type RendererInternal = {
    containerState: WeakMap<
      object,
      {
        cachedRecordsRef: ReadonlyArray<AnnotationRecord> | null;
        cachedAssignment: {
          lanes: Int16Array;
          numLanes: number;
          droppedCount: number;
        } | null;
        cachedMaxRows: number;
        meshState: { vertexCount: number } | null;
      }
    >;
  };

  it('reports overflow=true when assignment.droppedCount > 0', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({
      type: 'annotation-test',
    });
    const container = renderer.mount({
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
      theme: webglThemeForMode('light'),
    });
    const records: AnnotationRecord[] = Array.from({ length: 10 }, (_, i) => ({
      chrom: 'chr1',
      start: i * 10,
      end: i * 10 + 1000,
    }));
    const state = (renderer as unknown as RendererInternal).containerState.get(container)!;
    state.cachedRecordsRef = records;
    state.cachedAssignment = {
      lanes: new Int16Array(10).fill(-1),
      numLanes: 4,
      droppedCount: 6,
    };
    state.cachedMaxRows = 4;
    state.meshState = { vertexCount: 24 };

    const diag = renderer.getDiagnostics(container)!;
    expect(diag.recordCount).toBe(10);
    expect(diag.droppedRecordCount).toBe(6);
    expect(diag.visibleRecordCount).toBe(4);
    expect(diag.lanesUsed).toBe(4);
    expect(diag.maxLanes).toBe(4);
    expect(diag.overflow).toBe(true);
    expect(diag.utilizationFraction).toBe(1);
    expect(diag.vertexCount).toBe(24);
  });

  it('utilizationFraction tracks lanesUsed / maxLanes (soft-overflow warning)', async () => {
    const { PixiAnnotationTrackRenderer } = await import('./annotation-track-renderer');
    const renderer = new PixiAnnotationTrackRenderer({
      type: 'annotation-test',
    });
    const container = renderer.mount({
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
      theme: webglThemeForMode('light'),
    });
    const state = (renderer as unknown as RendererInternal).containerState.get(container)!;
    state.cachedRecordsRef = [];
    state.cachedAssignment = {
      lanes: new Int16Array(0),
      numLanes: 12,
      droppedCount: 0,
    };
    state.cachedMaxRows = 16;
    const diag = renderer.getDiagnostics(container)!;
    expect(diag.utilizationFraction).toBe(0.75);
    expect(diag.overflow).toBe(false);
  });
});
