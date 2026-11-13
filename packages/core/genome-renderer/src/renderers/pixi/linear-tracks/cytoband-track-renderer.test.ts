// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { CytoBand } from '@waypoint/genome-data';

import type { Assembly } from '../../../assembly';
import { buildAssembly } from '../../../assembly-layout';
import { webglThemeForMode } from '../shared/theme';
import type { TrackHitArgs, TrackMountArgs, TrackPaintArgs } from './types';

let cytobandRendererModule: typeof import('./cytoband-track-renderer');

beforeAll(async () => {
  if (typeof CanvasRenderingContext2D === 'undefined') {
    (globalThis as unknown as { CanvasRenderingContext2D: unknown }).CanvasRenderingContext2D =
      class CanvasRenderingContext2D {};
  }
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
  cytobandRendererModule = await import('./cytoband-track-renderer');
}, 15_000);

const CYTOBANDS: CytoBand[] = [
  { chrom: 'chr11', start: 0, end: 100, name: 'p11.1', stain: 'gneg' },
  { chrom: 'chr11', start: 100, end: 200, name: 'p11.2', stain: 'gpos100' },
  { chrom: 'chr11', start: 200, end: 250, name: 'p11.3', stain: 'acen' },
  { chrom: 'chr11', start: 250, end: 300, name: 'q11.1', stain: 'acen' },
  { chrom: 'chr11', start: 300, end: 400, name: 'q11.2', stain: 'gvar' },
];

const CHROM = {
  id: 'chr11',
  displayName: 'chr11',
  length: 400,
  cytobands: CYTOBANDS,
  morphology: {
    kind: 'localized' as const,
    interval: { startBp: 200, endBp: 300 },
    topology: 'internal' as const,
  },
};
const mountArgs: TrackMountArgs = { chromosome: CHROM, theme: webglThemeForMode('light') };

function paintArgs(container: object, mode: 'light' | 'dark'): TrackPaintArgs<unknown> {
  return {
    container,
    data: undefined,
    chromosome: CHROM,
    pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
    viewportBpRange: { start: 100, end: 200 },
    viewportWidthPx: 800,
    viewportHeightPx: 400,
    layoutEntry: {
      id: 'cytoband-test',
      top: 0,
      height: 26,
      contentClipped: false,
      hidden: false,
    },
    containerTopPx: 0,
    renderer: undefined,
    theme: webglThemeForMode(mode),
  } as unknown as TrackPaintArgs<unknown>;
}

function relativeLuminance(color: string | number): number {
  const value = typeof color === 'number' ? color : Number.parseInt(color.slice(1), 16);
  const channels = [value >> 16, value >> 8, value].map((channel) => {
    const normalized = (channel & 0xff) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(first: string | number, second: string | number): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

describe('PixiCytobandTrackRenderer silhouette palette', () => {
  it('omits a viewport indicator when the camera covers the complete assembly', () => {
    const { resolveViewportIndicatorLayout } = cytobandRendererModule;

    expect(resolveViewportIndicatorLayout(0, 400, 400, 800)).toBeNull();
    expect(resolveViewportIndicatorLayout(-25, 425, 400, 800)).toBeNull();
    expect(resolveViewportIndicatorLayout(0, 399.9, 400, 800)).toBeNull();
    expect(resolveViewportIndicatorLayout(0, 399, 400, 800)).toEqual({
      startBp: 0,
      endBp: 399,
      leftPx: 0,
      widthPx: 798,
    });
    expect(resolveViewportIndicatorLayout(399.9, 400, 400, 800)).toEqual({
      startBp: 399.9,
      endBp: 400,
      leftPx: 798,
      widthPx: 2,
    });
  });

  it('contains no legacy cytoband stain palette in light mode', () => {
    const { cytobandPaletteForTheme } = cytobandRendererModule;

    const palette = cytobandPaletteForTheme('light');
    expect(palette).not.toHaveProperty('stains');
    expect(palette).not.toHaveProperty('unknownStain');
    expect(palette.header).toBe('#3730a3');
    expect(palette.stripFill).toBe('#a19ce5');
    expect(palette.fullViewFill).toBe('#4338ca');
    expect(palette).not.toHaveProperty('stripOutline');
    expect(palette).not.toHaveProperty('stripOutlineWidth');
    expect(palette.viewportIndicator).toBe(0x4a40d2);
    expect(palette.viewportIndicatorAlpha).toBe(1);
    expect(palette.hover).toBe(0x4a40d2);
    expect(palette.hoverAlpha).toBe(1);
    expect(palette.separator).toBe(0xffffff);
    expect(palette).not.toHaveProperty('labelHover');
    expect(palette).not.toHaveProperty('bodyHover');
    expect(palette.labelHoverText).toBe('#4a40d2');
    expect(relativeLuminance(palette.viewportIndicator)).toBeLessThan(
      relativeLuminance(palette.stripFill)
    );
  });

  it('uses an outline-free dark-mode treatment without stain colors', () => {
    const { cytobandPaletteForTheme } = cytobandRendererModule;

    const palette = cytobandPaletteForTheme('dark');
    expect(palette).not.toHaveProperty('stains');
    expect(palette).not.toHaveProperty('unknownStain');
    expect(palette.header).toBe('#e0e7ff');
    expect(palette.stripFill).toBe('#a8a9f7');
    expect(palette.fullViewFill).toBe('#6366f1');
    expect(palette).not.toHaveProperty('stripOutline');
    expect(palette).not.toHaveProperty('stripOutlineWidth');
    expect(palette.viewportIndicator).toBe(0x6366f1);
    expect(palette.viewportIndicatorAlpha).toBe(1);
    expect(palette.hover).toBe(0x6366f1);
    expect(palette.hoverAlpha).toBe(1);
    expect(palette.separator).toBe(0x1e1c1a);
    expect(palette).not.toHaveProperty('labelHover');
    expect(palette).not.toHaveProperty('bodyHover');
    expect(palette.labelHoverText).toBe('#6366f1');
    expect(relativeLuminance(palette.viewportIndicator)).toBeLessThan(
      relativeLuminance(palette.stripFill)
    );

    const lightPalette = cytobandPaletteForTheme('light');
    expect(palette.stripFill).not.toBe(lightPalette.stripFill);
  });

  it.each([
    ['light', 0xffffff, 2, 2.8],
    ['dark', 0x1e1c1a, 3, 2],
  ] as const)(
    'keeps fill-only states distinguishable in %s mode',
    (mode, canvasBackground, minimumBodyContrast, minimumHighlightContrast) => {
      const { cytobandPaletteForTheme } = cytobandRendererModule;
      const palette = cytobandPaletteForTheme(mode);

      expect(contrastRatio(palette.stripFill, canvasBackground)).toBeGreaterThanOrEqual(
        minimumBodyContrast
      );
      expect(contrastRatio(palette.viewportIndicator, palette.stripFill)).toBeGreaterThanOrEqual(
        minimumHighlightContrast
      );
      expect(contrastRatio(palette.hover, palette.stripFill)).toBeGreaterThanOrEqual(
        minimumHighlightContrast
      );
    }
  );

  it('recolors only the chromosome silhouette inside the viewport range', () => {
    const { PixiCytobandTrackRenderer, cytobandPaletteForTheme } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const container = renderer.mount(mountArgs);
    const state = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          {
            bodyGfx: {
              fill: (...args: unknown[]) => unknown;
              stroke: (...args: unknown[]) => unknown;
            };
            indicator: {
              root: { children: unknown[] };
              highlight: {
                fill: (...args: unknown[]) => unknown;
                bezierCurveTo: (...args: unknown[]) => unknown;
                mask: unknown;
              };
              clip: {
                position: { x: number; y: number };
                scale: { x: number; y: number };
              };
              geometryBuildCount: number;
            };
            hoverIndicator: { root: object };
            labelTexts: Array<{ style: { fill?: unknown } }>;
          }
        >;
      }
    ).containerState.get(container)!;
    const bodyFillSpy = vi.spyOn(state.bodyGfx, 'fill');
    const outlineStrokeSpy = vi.spyOn(state.bodyGfx, 'stroke');
    const indicatorFillSpy = vi.spyOn(state.indicator.highlight, 'fill');
    const indicatorCurveSpy = vi.spyOn(state.indicator.highlight, 'bezierCurveTo');
    const palette = cytobandPaletteForTheme('dark');

    renderer.paint(paintArgs(container, 'dark'));

    expect(bodyFillSpy).toHaveBeenCalledTimes(1);
    expect(bodyFillSpy).toHaveBeenCalledWith({ color: palette.stripFill });
    expect(outlineStrokeSpy).not.toHaveBeenCalled();
    expect(state.indicator.root.children).toHaveLength(2);
    expect(container.children.indexOf(state.indicator.root as never)).toBeLessThan(
      container.children.indexOf(state.hoverIndicator.root as never)
    );
    expect(indicatorFillSpy).toHaveBeenCalledWith({ color: palette.viewportIndicator });
    expect(indicatorCurveSpy).toHaveBeenCalled();
    expect(state.indicator.highlight.mask).toBe(state.indicator.clip);
    expect(state.indicator.clip.position.x).toBe(200);
    expect(state.indicator.clip.position.y).toBe(0);
    expect(state.indicator.clip.scale.x).toBe(200);
    expect(state.indicator.clip.scale.y).toBe(14);
    expect(state.labelTexts[0].style.fill).toBe(palette.header);

    const diagnostics = renderer.getDiagnostics(container)!;
    expect(diagnostics.themeMode).toBe('dark');
    expect(diagnostics.legacyCytobandFillCount).toBe(0);
    expect(diagnostics.sourceCytobandCount).toBe(CYTOBANDS.length);
    expect(diagnostics.headerColor).toBe('#e0e7ff');
    expect(diagnostics.stripFillColor).toBe('#a8a9f7');
    expect(diagnostics.stripOutlineWidthPx).toBe(0);
    expect(diagnostics.bodyFillCount).toBe(1);
    expect(diagnostics.viewportIndicatorColor).toBe(0x6366f1);
    expect(diagnostics.viewportIndicatorAlpha).toBe(1);
    expect(diagnostics.viewportIndicatorMode).toBe('silhouette-recolor');
    expect(diagnostics.viewportIndicatorClipHeightPx).toBe(14);
  });

  it('retains viewport-indicator geometry across camera-only paints', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const container = renderer.mount(mountArgs);
    const firstArgs = paintArgs(container, 'light');

    renderer.paint(firstArgs);
    expect(renderer.getDiagnostics(container)?.viewportIndicatorGeometryBuildCount).toBe(1);

    renderer.paint({
      ...firstArgs,
      viewportBpRange: { start: 150, end: 250 },
    });
    expect(renderer.getDiagnostics(container)?.viewportIndicatorGeometryBuildCount).toBe(1);
  });

  it.each([
    ['light', '#4338ca'],
    ['dark', '#6366f1'],
  ] as const)('keeps the complete assembly dark in %s mode', (mode, expectedFill) => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const container = renderer.mount({ ...mountArgs, theme: webglThemeForMode(mode) });
    const state = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          {
            bodyGfx: { fill: (...args: unknown[]) => unknown };
            indicator: { root: { visible: boolean } };
          }
        >;
      }
    ).containerState.get(container)!;
    const bodyFillSpy = vi.spyOn(state.bodyGfx, 'fill');

    renderer.paint({
      ...paintArgs(container, mode),
      viewportBpRange: { start: 0, end: CHROM.length },
    });

    expect(state.indicator.root.visible).toBe(false);
    expect(bodyFillSpy).toHaveBeenCalledWith({ color: expectedFill });
    expect(renderer.getDiagnostics(container)).toMatchObject({
      stripFillColor: expectedFill,
      viewportStartBp: null,
      viewportEndBp: null,
      viewportIndicatorLeftPx: null,
      viewportIndicatorWidthPx: null,
    });
  });
});

describe('PixiCytobandTrackRenderer multi-chromosome assembly', () => {
  const CHR_A = { id: 'chrA', displayName: 'chrA', length: 400, cytobands: CYTOBANDS };
  const CHR_B = {
    id: 'chrB',
    displayName: 'chrB',
    length: 200,
    cytobands: [
      { chrom: 'chrB', start: 0, end: 100, name: 'p1', stain: 'gneg' as const },
      { chrom: 'chrB', start: 100, end: 200, name: 'q1', stain: 'gpos50' as const },
    ],
  };

  function assemblyPaintArgs(
    container: object,
    assembly: Assembly,
    allocatedHeightPx = 32
  ): TrackPaintArgs<unknown> {
    return {
      container,
      data: undefined,
      chromosome: assembly.chromosomes[0].chromosome,
      assembly,
      pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
      viewportBpRange: { start: 100, end: 200 },
      viewportWidthPx: 600,
      viewportHeightPx: 400,
      layoutEntry: {
        id: 'cytoband-test',
        top: 0,
        height: allocatedHeightPx,
        contentClipped: false,
        hidden: false,
      },
      containerTopPx: 0,
      renderer: undefined,
      theme: webglThemeForMode('light'),
    } as unknown as TrackPaintArgs<unknown>;
  }

  it('lays generic contigs on the shared axis with one visible boundary separator', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const assembly = buildAssembly('asm', 'asm', [CHR_A, CHR_B]);
    const container = renderer.mount({
      chromosome: CHR_A,
      assembly,
      theme: webglThemeForMode('light'),
    });
    const state = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          {
            labelTexts: Array<{
              text: string;
              visible: boolean;
              position: { y: number };
              style: { lineHeight: number };
            }>;
            separatorGfx?: {
              rect: (...args: number[]) => unknown;
              fill: (...args: unknown[]) => unknown;
            };
          }
        >;
      }
    ).containerState.get(container)!;
    expect(state.separatorGfx).toBeDefined();
    if (!state.separatorGfx) throw new Error('generic-contig separator graphics are missing');
    const separatorRectSpy = vi.spyOn(state.separatorGfx, 'rect');
    const separatorFillSpy = vi.spyOn(state.separatorGfx, 'fill');
    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(state.labelTexts.filter((t) => t.visible).map((t) => t.text)).toEqual(['chrA', 'chrB']);
    expect(separatorRectSpy).toHaveBeenCalledExactlyOnceWith(399.5, 0, 1, 14);
    expect(separatorFillSpy).toHaveBeenCalledExactlyOnceWith({ color: 0xffffff });
    expect(renderer.getDiagnostics(container)).toMatchObject({
      chromosomeCount: 2,
      allocatedHeightPx: 32,
      labelTopPx: 16,
      labelBottomPx: 30,
      contentBottomPx: 32,
      overflowPx: 0,
      labelsFit: true,
      visibleLabelCount: 2,
      hiddenLabelCount: 0,
      dividerLineCount: 1,
    });
    for (const label of state.labelTexts.filter((t) => t.visible)) {
      expect(label.position.y).toBe(16);
      expect(label.style.lineHeight).toBe(14);
      expect(label.position.y + label.style.lineHeight).toBeLessThanOrEqual(30);
    }
  });

  it('keeps adjoining chromosome silhouettes free of separator lines', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const chrA = {
      ...CHR_A,
      morphology: {
        kind: 'localized' as const,
        interval: { startBp: 150, endBp: 250 },
        topology: 'internal' as const,
      },
    };
    const chrB = {
      ...CHR_B,
      morphology: {
        kind: 'localized' as const,
        interval: { startBp: 70, endBp: 130 },
        topology: 'internal' as const,
      },
    };
    const assembly = buildAssembly('shaped', 'shaped', [chrA, chrB]);
    const container = renderer.mount({
      chromosome: chrA,
      assembly,
      theme: webglThemeForMode('light'),
    });

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(renderer.getDiagnostics(container)).toMatchObject({
      silhouetteChromosomeCount: 2,
      genericContigCount: 0,
      dividerLineCount: 0,
    });
  });

  it('renders holocentric members as filled rounded bodies without a waist', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const holocentric = { ...CHR_A, morphology: { kind: 'holocentric' as const } };
    const assembly = buildAssembly('holocentric', 'holocentric', [holocentric]);
    const container = renderer.mount({
      chromosome: holocentric,
      assembly,
      theme: webglThemeForMode('light'),
    });

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(renderer.getDiagnostics(container)).toMatchObject({
      silhouetteChromosomeCount: 1,
      genericContigCount: 0,
      bodyFillCount: 1,
      dividerLineCount: 0,
      morphology: [
        {
          chromosomeId: 'chrA',
          kind: 'chromosome-silhouette',
          morphologyKind: 'holocentric',
          leftPx: 0,
          rightPx: 600,
        },
      ],
    });
  });

  it('renders whole chromosomes with unresolved centromere positions as rounded bodies without separators', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const unresolved = {
      ...CHR_A,
      morphology: { kind: 'unlocalized-centromere' as const },
    };
    const assembly = buildAssembly('unresolved', 'unresolved', [unresolved]);
    const container = renderer.mount({
      chromosome: unresolved,
      assembly,
      theme: webglThemeForMode('light'),
    });

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(renderer.getDiagnostics(container)).toMatchObject({
      silhouetteChromosomeCount: 1,
      genericContigCount: 0,
      bodyFillCount: 1,
      dividerLineCount: 0,
      morphology: [
        {
          chromosomeId: 'chrA',
          kind: 'chromosome-silhouette',
          morphologyKind: 'unlocalized-centromere',
          leftPx: 0,
          rightPx: 600,
        },
      ],
    });
  });

  it('renders reviewed schematic morphology as a silhouette rather than a generic contig', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const schematic = {
      ...CHR_A,
      morphology: {
        kind: 'schematic' as const,
        centromereClass: 'acrocentric' as const,
        shortArmAt: 'start' as const,
      },
    };
    const assembly = buildAssembly('schematic', 'schematic', [schematic]);
    const container = renderer.mount({
      chromosome: schematic,
      assembly,
      theme: webglThemeForMode('light'),
    });

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(renderer.getDiagnostics(container)).toMatchObject({
      silhouetteChromosomeCount: 1,
      genericContigCount: 0,
      bodyFillCount: 1,
      dividerLineCount: 0,
      morphology: [
        {
          chromosomeId: 'chrA',
          kind: 'chromosome-silhouette',
          morphologyKind: 'schematic',
          leftPx: 0,
          rightPx: 600,
          centromereStartPx: 60,
          centromereEndPx: 60,
        },
      ],
    });
  });

  it.each([
    ['terminal-start', { startBp: 1, endBp: 20 }],
    ['terminal-end', { startBp: 380, endBp: 399 }],
  ] as const)('joins the %s taper and circular cap with mutual tangency', (topology, interval) => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const terminal = {
      ...CHR_A,
      morphology: {
        kind: 'localized' as const,
        interval,
        topology,
      },
    };
    const assembly = buildAssembly('terminal', 'terminal', [terminal]);
    const container = renderer.mount({
      chromosome: terminal,
      assembly,
      theme: webglThemeForMode('light'),
    });
    const bodyGfx = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          { bodyGfx: { bezierCurveTo: (...args: number[]) => unknown } }
        >;
      }
    ).containerState.get(container)!.bodyGfx;
    const curveSpy = vi.spyOn(bodyGfx, 'bezierCurveTo');

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(curveSpy.mock.calls).toHaveLength(6);
    const curves = curveSpy.mock.calls;
    const endPoint = (curveIndex: number) => ({
      x: curves[curveIndex][4],
      y: curves[curveIndex][5],
    });
    const firstControl = (curveIndex: number) => ({
      x: curves[curveIndex][0],
      y: curves[curveIndex][1],
    });
    const secondControl = (curveIndex: number) => ({
      x: curves[curveIndex][2],
      y: curves[curveIndex][3],
    });
    const profile =
      topology === 'terminal-start'
        ? {
            center: { x: 4, y: 7 },
            tip: endPoint(4),
            upper: endPoint(5),
            lower: endPoint(3),
            upperIncoming: secondControl(5),
            upperOutgoing: firstControl(0),
            lowerIncoming: secondControl(3),
            lowerOutgoing: firstControl(4),
          }
        : {
            center: { x: 596, y: 7 },
            tip: endPoint(1),
            upper: endPoint(0),
            lower: endPoint(2),
            upperIncoming: secondControl(0),
            upperOutgoing: firstControl(1),
            lowerIncoming: secondControl(2),
            lowerOutgoing: firstControl(3),
          };

    expect(profile.tip).toEqual({ x: topology === 'terminal-start' ? 0 : 600, y: 7 });
    expect(Math.hypot(profile.upper.x - profile.center.x, profile.upper.y - 7)).toBeCloseTo(4);
    expect(Math.hypot(profile.lower.x - profile.center.x, profile.lower.y - 7)).toBeCloseTo(4);

    for (const [point, incomingControl, outgoingControl] of [
      [profile.upper, profile.upperIncoming, profile.upperOutgoing],
      [profile.lower, profile.lowerIncoming, profile.lowerOutgoing],
    ] as const) {
      const incoming = { x: point.x - incomingControl.x, y: point.y - incomingControl.y };
      const outgoing = { x: outgoingControl.x - point.x, y: outgoingControl.y - point.y };
      expect(incoming.x * outgoing.y - incoming.y * outgoing.x).toBeCloseTo(0);
      expect(incoming.x * outgoing.x + incoming.y * outgoing.y).toBeGreaterThan(0);
    }
  });

  it('renders adjoining chromosome arms as one body with one waist and no seam', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const leftArm = {
      ...CHR_A,
      id: 'chr2L',
      morphology: { kind: 'between-members' as const, groupId: 'chr2', side: 'right' as const },
    };
    const rightArm = {
      ...CHR_B,
      id: 'chr2R',
      morphology: { kind: 'between-members' as const, groupId: 'chr2', side: 'left' as const },
    };
    const assembly = buildAssembly('split-arms', 'split-arms', [leftArm, rightArm]);
    const container = renderer.mount({
      chromosome: leftArm,
      assembly,
      theme: webglThemeForMode('light'),
    });
    const bodyGfx = (
      renderer as unknown as {
        containerState: WeakMap<object, { bodyGfx: { fill: (...args: unknown[]) => unknown } }>;
      }
    ).containerState.get(container)!.bodyGfx;
    const fillSpy = vi.spyOn(bodyGfx, 'fill');

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(fillSpy).toHaveBeenCalledTimes(1);
    expect(renderer.getDiagnostics(container)).toMatchObject({
      chromosomeCount: 2,
      silhouetteChromosomeCount: 2,
      genericContigCount: 0,
      bodyFillCount: 1,
      dividerLineCount: 0,
      morphology: [
        {
          chromosomeId: 'chr2L',
          kind: 'chromosome-silhouette',
          morphologyKind: 'between-members',
          centromereStartPx: 400,
          centromereEndPx: 400,
        },
        {
          chromosomeId: 'chr2R',
          kind: 'chromosome-silhouette',
          morphologyKind: 'between-members',
          centromereStartPx: 400,
          centromereEndPx: 400,
        },
      ],
    });
  });

  it('compacts chromosome labels and hides only labels that cannot fit their contig span', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const chr1 = { ...CHR_A, id: 'chr1', displayName: 'chr1', length: 280 };
    const chr2 = { ...CHR_B, id: 'chr2', displayName: 'chr2', length: 280 };
    const tiny = {
      ...CHR_B,
      id: 'tiny',
      displayName: 'tiny-contig',
      length: 40,
      cytobands: [],
    };
    const assembly = buildAssembly('labels', 'labels', [chr1, chr2, tiny]);
    const container = renderer.mount({
      chromosome: chr1,
      assembly,
      theme: webglThemeForMode('light'),
    });
    const labels = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          { labelTexts: Array<{ text: string; visible: boolean; position: { x: number } }> }
        >;
      }
    ).containerState.get(container)!.labelTexts;

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(labels.map(({ text, visible }) => ({ text, visible }))).toEqual([
      { text: '1', visible: true },
      { text: '2', visible: true },
      { text: 'tiny-contig', visible: false },
    ]);
    expect(labels.slice(0, 2).map(({ position }) => position.x)).toEqual([140, 420]);
    expect(renderer.getDiagnostics(container)).toMatchObject({
      chromosomeCount: 3,
      visibleLabelCount: 2,
      hiddenLabelCount: 1,
      labelLayouts: [
        { chromosomeId: 'chr1', text: '1', visible: true },
        { chromosomeId: 'chr2', text: '2', visible: true },
        { chromosomeId: 'tiny', text: 'tiny-contig', visible: false },
      ],
    });
  });

  it('detaches chromosome label styles when the track unmounts', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const assembly = buildAssembly('asm', 'asm', [CHR_A, CHR_B]);
    const container = renderer.mount({
      chromosome: CHR_A,
      assembly,
      theme: webglThemeForMode('light'),
    });
    renderer.paint(assemblyPaintArgs(container, assembly));
    const labels = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          {
            labelTexts: Array<{
              destroyed: boolean;
              style: { listenerCount(name: string): number };
            }>;
          }
        >;
      }
    ).containerState.get(container)!.labelTexts;
    const styles = labels.map((label) => label.style);

    expect(labels).toHaveLength(2);
    expect(styles.map((style) => style.listenerCount('update'))).toEqual([1, 1]);

    renderer.unmount(container);

    expect(labels.every((label) => label.destroyed)).toBe(true);
    expect(styles.map((style) => style.listenerCount('update'))).toEqual([0, 0]);
  });

  it('fails closed when a clipped slot cannot contain chromosome labels, then restores them', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const assembly = buildAssembly('asm', 'asm', [CHR_A, CHR_B]);
    const container = renderer.mount({
      chromosome: CHR_A,
      assembly,
      theme: webglThemeForMode('light'),
    });

    renderer.paint(assemblyPaintArgs(container, assembly, 26));
    expect(renderer.getDiagnostics(container)).toMatchObject({
      allocatedHeightPx: 26,
      overflowPx: 6,
      labelsFit: false,
      chromosomeCount: 2,
      visibleLabelCount: 0,
      hiddenLabelCount: 2,
    });

    renderer.paint(assemblyPaintArgs(container, assembly, 32));
    expect(renderer.getDiagnostics(container)).toMatchObject({
      allocatedHeightPx: 32,
      overflowPx: 0,
      labelsFit: true,
      chromosomeCount: 2,
    });
  });

  it('hitTest returns the GLOBAL-axis bp under the click (the camera axis)', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const assembly = buildAssembly('asm', 'asm', [CHR_A, CHR_B]);
    const hit = renderer.hitTest({
      localX: 450,
      localY: 5,
      viewportWidthPx: 600,
      layoutEntry: { id: 'c', top: 0, height: 32, contentClipped: false, hidden: false },
      pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
      viewportBpRange: { start: 0, end: 600 },
      chromosome: CHR_A,
      assembly,
    } as unknown as TrackHitArgs);
    expect(hit).toEqual({ kind: 'jump-to-bp', bp: 450 });
  });

  it('frames a chromosome from its visible label while body clicks retain click-to-jump', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const assembly = buildAssembly('asm', 'asm', [CHR_A, CHR_B]);

    expect(
      renderer.hitTest({
        localX: 200,
        localY: 22,
        viewportWidthPx: 600,
        layoutEntry: {
          id: 'c',
          top: 0,
          height: 32,
          contentClipped: false,
          hidden: false,
        },
        pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
        viewportBpRange: { start: 100, end: 200 },
        chromosome: CHR_A,
        assembly,
      } as unknown as TrackHitArgs)
    ).toEqual({ kind: 'frame-bp-range', startBp: 0, endBp: 400, chromosomeId: 'chrA' });

    expect(
      renderer.hitTest({
        localX: 180,
        localY: 22,
        viewportWidthPx: 600,
        layoutEntry: {
          id: 'c',
          top: 0,
          height: 32,
          contentClipped: false,
          hidden: false,
        },
        pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
        viewportBpRange: { start: 100, end: 200 },
        chromosome: CHR_A,
        assembly,
      } as unknown as TrackHitArgs)
    ).toEqual({ kind: 'frame-bp-range', startBp: 0, endBp: 400, chromosomeId: 'chrA' });

    expect(
      renderer.hitTest({
        localX: 450,
        localY: 5,
        viewportWidthPx: 600,
        layoutEntry: {
          id: 'c',
          top: 0,
          height: 32,
          contentClipped: false,
          hidden: false,
        },
        pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
        viewportBpRange: { start: 100, end: 200 },
        chromosome: CHR_A,
        assembly,
      } as unknown as TrackHitArgs)
    ).toEqual({ kind: 'jump-to-bp', bp: 450 });
  });

  it('previews chromosome framing on label hover and a same-span pan on body hover', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const assembly = buildAssembly('asm', 'asm', [CHR_A, CHR_B]);
    const container = renderer.mount({
      chromosome: CHR_A,
      assembly,
      theme: webglThemeForMode('light'),
    });
    renderer.paint(assemblyPaintArgs(container, assembly));
    const hoverRenderer = renderer as unknown as {
      updateHover: (args: TrackHitArgs & { container: object }) => void;
      clearHover: (container: object) => void;
    };
    const state = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          { labelTexts: Array<{ style: { fill?: unknown; fontWeight?: unknown } }> }
        >;
      }
    ).containerState.get(container)!;
    const commonHoverArgs = {
      container,
      viewportWidthPx: 600,
      layoutEntry: {
        id: 'c',
        top: 0,
        height: 32,
        contentClipped: false,
        hidden: false,
      },
      pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
      viewportBpRange: { start: 100, end: 200 },
      chromosome: CHR_A,
      assembly,
    } as unknown as TrackHitArgs & { container: object };

    expect(typeof hoverRenderer.updateHover).toBe('function');
    expect(typeof hoverRenderer.clearHover).toBe('function');
    hoverRenderer.updateHover({ ...commonHoverArgs, localX: 180, localY: 22 });

    expect(renderer.getDiagnostics(container)).toMatchObject({
      viewportStartBp: 100,
      viewportEndBp: 200,
      hoverPreviewMode: 'chromosome-frame',
      hoverPreviewStartBp: 0,
      hoverPreviewEndBp: 400,
      hoverPreviewLeftPx: 0,
      hoverPreviewWidthPx: 400,
      hoveredChromosomeId: 'chrA',
      hoverPreviewColor: 0x4a40d2,
      hoverPreviewAlpha: 1,
    });
    expect(state.labelTexts[0].style.fill).toBe('#4a40d2');
    expect(state.labelTexts[0].style.fontWeight).toBe('700');
    expect(container.cursor).toBe('zoom-in');

    hoverRenderer.updateHover({ ...commonHoverArgs, localX: 450, localY: 5 });

    expect(renderer.getDiagnostics(container)).toMatchObject({
      viewportStartBp: 100,
      viewportEndBp: 200,
      hoverPreviewMode: 'viewport-pan',
      hoverPreviewStartBp: 400,
      hoverPreviewEndBp: 500,
      hoverPreviewLeftPx: 400,
      hoverPreviewWidthPx: 100,
      hoveredChromosomeId: null,
      hoverPreviewColor: 0x4a40d2,
      hoverPreviewAlpha: 1,
    });
    expect(state.labelTexts[0].style.fill).toBe('#3730a3');
    expect(state.labelTexts[0].style.fontWeight).toBe('normal');
    expect(container.cursor).toBe('pointer');

    renderer.paint({
      ...assemblyPaintArgs(container, assembly),
      viewportBpRange: { start: 100, end: 300 },
    });
    expect(renderer.getDiagnostics(container)).toMatchObject({
      hoverPreviewMode: null,
      hoverPreviewStartBp: null,
      hoverPreviewEndBp: null,
      hoveredChromosomeId: null,
    });
    expect(container.cursor).toBe('default');

    hoverRenderer.clearHover(container);
    expect(renderer.getDiagnostics(container)).toMatchObject({
      hoverPreviewMode: null,
      hoverPreviewStartBp: null,
      hoverPreviewEndBp: null,
      hoveredChromosomeId: null,
    });
    expect(container.cursor).toBe('default');
  });

  it('renders a mixed silhouette and generic contig without changing height or axis mapping', () => {
    const { PixiCytobandTrackRenderer } = cytobandRendererModule;
    const renderer = new PixiCytobandTrackRenderer();
    const chromosome = {
      ...CHR_A,
      morphology: {
        kind: 'localized' as const,
        interval: { startBp: 200, endBp: 300 },
        topology: 'internal' as const,
      },
    };
    const contig = { ...CHR_B, cytobands: [] };
    const assembly = buildAssembly('mixed', 'mixed', [chromosome, contig]);
    const container = renderer.mount({
      chromosome,
      assembly,
      theme: webglThemeForMode('light'),
    });
    const bodyGfx = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          {
            bodyGfx: {
              fill: (...args: unknown[]) => unknown;
              lineTo: (...args: number[]) => unknown;
            };
          }
        >;
      }
    ).containerState.get(container)!.bodyGfx;
    const fillSpy = vi.spyOn(bodyGfx, 'fill');
    const lineToSpy = vi.spyOn(bodyGfx, 'lineTo');

    renderer.paint(assemblyPaintArgs(container, assembly));

    expect(fillSpy).toHaveBeenCalledTimes(2);
    expect(lineToSpy).not.toHaveBeenCalledWith(300, 1.5);
    expect(lineToSpy).not.toHaveBeenCalledWith(200, 12.5);

    expect(container.hitArea?.contains(450, 5)).toBe(true);
    expect(container.hitArea?.contains(450, 20)).toBe(true);
    expect(container.hitArea?.contains(450, 31)).toBe(false);
    expect(renderer.getDiagnostics(container)).toMatchObject({
      allocatedHeightPx: 32,
      contentBottomPx: 32,
      viewportStartBp: 100,
      viewportEndBp: 200,
      viewportIndicatorLeftPx: 100,
      viewportIndicatorWidthPx: 100,
      silhouetteChromosomeCount: 1,
      genericContigCount: 1,
      bodyFillCount: 2,
      dividerLineCount: 1,
      legacyCytobandFillCount: 0,
      sourceCytobandCount: CYTOBANDS.length,
      morphology: [
        {
          chromosomeId: 'chrA',
          kind: 'chromosome-silhouette',
          morphologyKind: 'localized',
          leftPx: 0,
          rightPx: 400,
          centromereStartPx: 200,
          centromereEndPx: 300,
        },
        {
          chromosomeId: 'chrB',
          kind: 'generic-contig',
          leftPx: 400,
          rightPx: 600,
        },
      ],
    });

    const hit = renderer.hitTest({
      localX: 450,
      localY: 5,
      viewportWidthPx: 600,
      layoutEntry: { id: 'c', top: 0, height: 32, contentClipped: false, hidden: false },
      pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
      viewportBpRange: { start: 0, end: 600 },
      chromosome,
      assembly,
    } as unknown as TrackHitArgs);
    expect(hit).toEqual({ kind: 'jump-to-bp', bp: 450 });
  });
});
