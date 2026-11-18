import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationChangeDecoration } from '@waypoint/genome-renderer';
import type { HoverFeatureInfo } from './use-pixi-map';
import type { Genome } from '@waypoint/genome-renderer';
import type { PixiMapHandle } from '@waypoint/genome-renderer/react';
import type { ParsedPlasmid } from '../../types';
import { WebGLMap } from './WebGLMap';
import { primerRenderId } from './plasmid-to-genome';

const presentationState = vi.hoisted(() => {
  const state: {
    genome: Genome | null;
    presented: Parameters<PixiMapHandle['subscribeToPresentedFrames']>[0] | null;
  } = { genome: null, presented: null };
  return state;
});

const pixiHost = vi.hoisted(() => ({
  containerRef: { current: null as HTMLDivElement | null },
  options: null as null | {
    genome: Genome;
    annotationChangeDecorations?: ReadonlyMap<number, AnnotationChangeDecoration>;
    highlightRange?: [number, number] | null;
    selectedFeatureIds?: ReadonlySet<number>;
  },
  onHoverChange: null as ((hover: HoverFeatureInfo | null) => void) | null,
  requestRender: vi.fn(),
  subscribeToPresentedFrames: vi.fn(
    (listener: Parameters<PixiMapHandle['subscribeToPresentedFrames']>[0]) => {
      presentationState.presented = listener;
      return () => {
        presentationState.presented = null;
      };
    }
  ),
}));

vi.mock('@waypoint/genome-renderer', async () => ({
  ...(await import('../../../../../core/genome-renderer/src/primer-render-conventions')),
  ...(await import('../../../../../core/genome-renderer/src/feature-colors')),
  ...(await import('../../../../../core/genome-renderer/src/annotation-data-colors')),
  genomeFeatures: (genome: { features?: readonly unknown[] }) => genome.features ?? [],
  perfLog: vi.fn(),
  perfMark: vi.fn(),
  recordWebGLSelectionDebug: vi.fn(),
}));

vi.mock('@waypoint/genome-renderer/react', () => ({
  pixiInitOptionsForPerformanceMode: vi.fn(),
  resolveWebGLPerformanceMode: () => 'default',
  WEBGL_PERFORMANCE_PREFERENCES: ['auto'],
}));

vi.mock('./use-pixi-map', () => ({
  useHiddenMapIdlePolicy: (fallback: string) => fallback,
  usePixiMap: (
    options: NonNullable<typeof pixiHost.options> & {
      onHoverChange?: (hover: HoverFeatureInfo | null) => void;
    }
  ) => {
    pixiHost.options = options;
    pixiHost.onHoverChange = options.onHoverChange ?? null;
    presentationState.genome = options.genome;
    return {
      containerRef: pixiHost.containerRef,
      handle: {
        getLinearRenderer: vi.fn(() => null),
        subscribeToPresentedFrames: pixiHost.subscribeToPresentedFrames,
        requestRender: pixiHost.requestRender,
      },
    };
  },
}));

afterEach(() => {
  cleanup();
  pixiHost.containerRef.current = null;
  pixiHost.onHoverChange = null;
  presentationState.genome = null;
  presentationState.presented = null;
  pixiHost.options = null;
  vi.clearAllMocks();
});

describe('WebGLMap DOM ownership', () => {
  it.each([false, true])(
    'recolors existing annotation presentation without replacing the host (circular=%s)',
    (circular) => {
      const plasmid: ParsedPlasmid = {
        name: 'source-bound markup fixture',
        length: 300,
        circular,
        sequence: 'ATG'.repeat(100),
        features: [
          {
            type: 'gene',
            start: 10,
            end: 150,
            direction: 'forward',
            qualifiers: { locus_tag: ['b1012'] },
            displayName: 'rutA',
            color: '#123456',
          },
        ],
        primers: [],
      };
      const { rerender } = render(
        <WebGLMap
          plasmid={plasmid}
          circular={circular}
          annotationColorsByIdentity={new Map([['b1012', '#aabbcc']])}
        />
      );
      const host = screen.getByTestId('webgl-render-host');
      expect(pixiHost.options?.genome.features?.[0].color).toBe(0xaabbcc);
      expect(plasmid.features[0].color).toBe('#123456');
      rerender(
        <WebGLMap
          plasmid={plasmid}
          circular={circular}
          annotationColorsByIdentity={new Map([['b1012', '#112233']])}
        />
      );
      expect(screen.getByTestId('webgl-render-host')).toBe(host);
      expect(pixiHost.options?.genome.features?.[0].color).toBe(0x112233);
      expect(plasmid.features[0].color).toBe('#123456');
    }
  );

  it('qualifies only a drawn frame carrying the exact current installed genome', () => {
    const presented = vi.fn();
    const plasmid: ParsedPlasmid = {
      name: 'orf frame fixture',
      length: 123,
      circular: false,
      sequence: 'ATG'.repeat(40) + 'TAA',
      features: [],
      primers: [],
    };
    render(
      <WebGLMap
        plasmid={plasmid}
        width={400}
        height={240}
        orfs={[{ start: 0, end: 122, strand: '+', frame: 1, length: 123 }]}
        onOrfsPresented={presented}
      />
    );
    const genome = presentationState.genome;
    if (!genome) throw new Error('Expected the component genome');
    expect(pixiHost.requestRender).toHaveBeenCalled();
    act(() => presentationState.presented?.({ frameEpoch: 1, presentedAtMs: 100 }));
    act(() =>
      presentationState.presented?.({
        frameEpoch: 2,
        presentedAtMs: 200,
        content: { genome: { ...genome }, orfsDrawn: true },
      })
    );
    act(() =>
      presentationState.presented?.({
        frameEpoch: 3,
        presentedAtMs: 300,
        content: { genome, orfsDrawn: false },
      })
    );
    expect(presented).not.toHaveBeenCalled();
    act(() =>
      presentationState.presented?.({
        frameEpoch: 4,
        presentedAtMs: 400,
        content: { genome, orfsDrawn: true },
      })
    );
    expect(presented).toHaveBeenCalledExactlyOnceWith({
      kind: 'orf_drawn',
      surface: 'plasmid_map',
    });
  });

  it('transports ordinary Git annotation-change names to exact native IDs without rebuilding the genome or selection', () => {
    const plasmid = {
      name: 'ordinary Git annotation cue',
      length: 12,
      circular: true,
      sequence: 'ATGCATGCATGC',
      primers: [],
      features: [
        {
          type: 'CDS',
          start: 1,
          end: 6,
          direction: 'forward' as const,
          qualifiers: {},
          displayName: 'Changed gene',
          color: '#2563eb',
        },
        {
          type: 'promoter',
          start: 7,
          end: 10,
          direction: 'forward' as const,
          qualifiers: {},
          displayName: 'Unchanged promoter',
          color: '#10b981',
        },
      ],
    };
    const selected = { type: 'CDS', name: 'Changed gene', start: 1, end: 6, direction: 1 as const };
    const { rerender } = render(
      <WebGLMap
        plasmid={plasmid}
        changedAnnotationNames={new Set(['Changed gene'])}
        selectionStart={1}
        selectionEnd={3}
        selectedAnnotation={selected}
      />
    );
    const first = pixiHost.options!;
    expect(Array.from(first.annotationChangeDecorations ?? [])).toEqual([
      [0, { kind: 'modified' }],
    ]);
    expect(first.highlightRange).toEqual([1, 3]);
    expect(Array.from(first.selectedFeatureIds ?? [])).toEqual([0]);
    rerender(
      <WebGLMap
        plasmid={plasmid}
        changedAnnotationNames={new Set(['Unchanged promoter'])}
        selectionStart={1}
        selectionEnd={3}
        selectedAnnotation={selected}
      />
    );
    expect(pixiHost.options!.genome).toBe(first.genome);
    expect(pixiHost.options!.highlightRange).toBe(first.highlightRange);
    expect(pixiHost.options!.selectedFeatureIds).toBe(first.selectedFeatureIds);
    expect(Array.from(pixiHost.options!.annotationChangeDecorations ?? [])).toEqual([
      [1, { kind: 'modified' }],
    ]);
    rerender(
      <WebGLMap
        plasmid={plasmid}
        selectionStart={1}
        selectionEnd={3}
        selectedAnnotation={selected}
      />
    );
    expect(pixiHost.options!.annotationChangeDecorations).toBeUndefined();
    expect(pixiHost.options!.genome).toBe(first.genome);
  });

  it('shows complete modification labels and codes on a saved attached primer hover', () => {
    render(
      <WebGLMap
        plasmid={{
          name: 'attached primer fixture',
          length: 12,
          circular: true,
          sequence: 'ATGCATGCATGC',
          features: [],
          primers: [
            {
              id: 'saved-binding',
              sourcePrimerId: 'saved-primer',
              name: 'Modified attached primer',
              start: 0,
              end: 12,
              direction: 'reverse',
              bases: 'GCATGCATGCAT',
              tm: 55,
              gc: 50,
              mismatches: [],
              hasExplicitSequence: true,
              modificationMarkers: [
                { label: '5′ phosphorylation', token: '/5Phos/' },
                { label: 'Internal Biotin-dT', token: '/iBiodT/' },
              ],
            },
          ],
        }}
        width={400}
        height={240}
      />
    );
    act(() =>
      pixiHost.onHoverChange?.({
        id: primerRenderId(0),
        start: 0,
        end: 12,
        screenX: 360,
        screenY: 220,
      })
    );
    const tooltip = screen.getByTestId('webgl-feature-tooltip');
    expect(tooltip.textContent).toContain('Internal Biotin-dT /iBiodT/');
    expect(tooltip.textContent).toContain('5′ phosphorylation /5Phos/');
    expect(tooltip.textContent).toContain('Modified attached primer');
    act(() => pixiHost.onHoverChange?.(null));
    expect(screen.queryByTestId('webgl-feature-tooltip')).toBeNull();
  });

  it.each(['forward', 'reverse'] as const)(
    'updates the %s CDS region within one feature without rerendering within a region',
    (direction) => {
      const onFeatureHover = vi.fn();
      render(
        <WebGLMap
          plasmid={{
            name: 'spliced CDS',
            length: 100,
            circular: false,
            sequence: 'A'.repeat(100),
            primers: [],
            features: [
              {
                type: 'CDS',
                start: 11,
                end: 90,
                direction,
                segments: [
                  { start: 11, end: 30 },
                  { start: 60, end: 90 },
                ],
                qualifiers: {},
                displayName: 'Spliced CDS',
                color: '#2563eb',
              },
            ],
          }}
          width={400}
          height={240}
          onFeatureHover={onFeatureHover}
        />
      );
      const hoverAt = (position: number) =>
        act(() =>
          pixiHost.onHoverChange?.({
            id: 0,
            start: 10,
            end: 90,
            position,
            screenX: position,
            screenY: 60,
          })
        );
      hoverAt(15);
      expect(screen.getByTestId('webgl-feature-tooltip').textContent).toContain(
        direction === 'forward' ? 'Exon 1' : 'Exon 2'
      );
      const renderCount = (window as Window & { __webglMapRenderCount?: number })
        .__webglMapRenderCount;
      hoverAt(16);
      expect((window as Window & { __webglMapRenderCount?: number }).__webglMapRenderCount).toBe(
        renderCount
      );
      hoverAt(45);
      expect(screen.getByTestId('webgl-feature-tooltip').textContent).toContain('Intron 1');
      hoverAt(65);
      const tooltip = screen.getByTestId('webgl-feature-tooltip');
      expect(tooltip.textContent).toContain(direction === 'forward' ? 'Exon 2' : 'Exon 1');
      expect(tooltip.textContent).not.toContain('Intron');
      expect(tooltip.textContent).toContain('Spliced CDS');
      expect(onFeatureHover).toHaveBeenCalledExactlyOnceWith(0);
    }
  );

  it('shows the origin-spanning intron from the rendered pointer base', () => {
    render(
      <WebGLMap
        plasmid={{
          name: 'origin-spanning CDS',
          length: 100,
          circular: true,
          sequence: 'A'.repeat(100),
          primers: [],
          features: [
            {
              type: 'CDS',
              start: 81,
              end: 30,
              direction: 'forward',
              segments: [
                { start: 81, end: 90 },
                { start: 11, end: 30 },
              ],
              qualifiers: {},
              displayName: 'Across origin',
              color: '#2563eb',
            },
          ],
        }}
        width={400}
        height={240}
      />
    );
    act(() =>
      pixiHost.onHoverChange?.({ id: 0, start: 80, end: 30, position: 5, screenX: 80, screenY: 60 })
    );
    expect(screen.getByTestId('webgl-feature-tooltip').textContent).toContain('Intron 1');
  });

  it('keeps React overlays outside the renderer-owned Pixi host', () => {
    render(
      <WebGLMap
        plasmid={{
          name: 'ownership fixture',
          length: 12,
          circular: true,
          sequence: 'ATGCATGCATGC',
          features: [
            {
              type: 'CDS',
              start: 1,
              end: 6,
              direction: 'forward',
              qualifiers: {},
              displayName: 'test feature',
              color: '#2563eb',
            },
          ],
          primers: [],
        }}
        width={400}
        height={240}
      />
    );

    act(() => {
      pixiHost.onHoverChange?.({
        id: 0,
        start: 0,
        end: 6,
        screenX: 80,
        screenY: 60,
      });
    });

    const renderHost = screen.getByTestId('webgl-render-host');
    const tooltip = screen.getByTestId('webgl-feature-tooltip');
    expect(pixiHost.containerRef.current).toBe(renderHost);
    expect(renderHost.contains(tooltip)).toBe(false);

    while (renderHost.firstChild) renderHost.removeChild(renderHost.firstChild);

    expect(screen.getByTestId('webgl-feature-tooltip')).toBe(tooltip);
  });
});
