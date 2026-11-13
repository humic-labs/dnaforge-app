import { CODON_FONT_WEIGHT, SEQUENCE_FONT_FAMILY, codonFontSize } from '@waypoint/platform';
// @vitest-environment jsdom

import {
  CanvasTextMetrics,
  Container,
  fontStringFromTextStyle,
  type Graphics,
  type Text,
} from 'pixi.js';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import { getCodonLetterPosition } from '../../../../../workspace-editor/src/rendering/canvas-primitives';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { translateCDS, type CodonInfo } from '../../../biology/translation';
import { compareProjectedCodons } from '../../../biology/codon-mutations';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { getLabelOccupancyRecords, resetLabelOccupancy } from '../shared/label-occupancy';
import { CodonTrack } from './codon-track';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      textBaseline: 'alphabetic',
      measureText(this: Pick<CanvasRenderingContext2D, 'font' | 'textBaseline'>, text: string) {
        const size = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10);
        const shift = this.textBaseline === 'middle' ? size * 0.25 : 0;
        return {
          width: text.length * 6,
          actualBoundingBoxAscent: size * (text.includes('|') ? 0.95 : 0.75) - shift,
          actualBoundingBoxDescent: size * (text.includes('|') ? 0.25 : 0) + shift,
        };
      },
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

function createState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 200,
    height: 120,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function createLinearPath(pixelsPerBp: number, calls: number[] = []): PathMapper {
  const y = 60;
  return {
    isArcMode: false,
    pixelsPerBp,
    viewStartBp: 0,
    rowHeight: 12,
    sequenceFontSize: 10,
    bpLeftX: (bp: number) => bp * pixelsPerBp,
    featureLabelPosAt: (bp: number, offsetPx: number) => {
      calls.push(bp);
      return {
        x: bp * pixelsPerBp + pixelsPerBp / 2,
        y: y + offsetPx,
        angle: 0,
      };
    },
    featurePolygonAt: (startBp: number, endBp: number, offsetPx: number, halfHeight = 7) => {
      const x1 = startBp * pixelsPerBp;
      const x2 = endBp * pixelsPerBp;
      const cy = y + offsetPx;
      return [x1, cy - halfHeight, x2, cy - halfHeight, x2, cy + halfHeight, x1, cy + halfHeight];
    },
    isFeatureVisible: () => true,
  } as unknown as PathMapper;
}

function createArcPath(): PathMapper {
  const cx = 100;
  const cy = 100;
  const radius = 50;
  const posAt = (bp: number, offsetPx: number) => {
    const theta = (bp / 20) * Math.PI;
    const r = radius + offsetPx;
    return {
      x: cx + Math.cos(theta) * r,
      y: cy + Math.sin(theta) * r,
      angle: theta + Math.PI / 2,
    };
  };
  return {
    isArcMode: true,
    pixelsPerBp: 8,
    rowHeight: 12,
    sequenceFontSize: 10,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offsetPx: number, halfHeight = 7) => {
      const outer: number[] = [];
      const inner: number[] = [];
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const bp = startBp + (endBp - startBp) * (i / steps);
        const p = posAt(bp, offsetPx);
        const nx = -Math.sin(p.angle);
        const ny = Math.cos(p.angle);
        outer.push(p.x - nx * halfHeight, p.y - ny * halfHeight);
        inner.unshift(p.y + ny * halfHeight);
        inner.unshift(p.x + nx * halfHeight);
      }
      return [...outer, ...inner];
    },
    isFeatureVisible: () => true,
  } as unknown as PathMapper;
}

function createBottomArcPath(): PathMapper {
  const posAt = (bp: number, offsetPx: number) => ({
    x: 180 - bp * 5,
    y: 80 + offsetPx,
    angle: Math.PI,
  });
  return {
    isArcMode: true,
    pixelsPerBp: 5,
    rowHeight: 12,
    sequenceFontSize: 10,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offsetPx: number, halfHeight = 7) => {
      const start = posAt(startBp, offsetPx);
      const end = posAt(endBp, offsetPx);
      return [
        start.x,
        start.y - halfHeight,
        end.x,
        end.y - halfHeight,
        end.x,
        end.y + halfHeight,
        start.x,
        start.y + halfHeight,
      ];
    },
    isFeatureVisible: () => true,
  } as unknown as PathMapper;
}

function createOriginWrappedArcPath(calls: number[]): PathMapper {
  const posAt = (bp: number, offsetPx: number) => {
    calls.push(bp);
    const norm = ((bp % 100) + 100) % 100;
    const x = norm >= 90 ? 20 + (norm - 90) * 4 : norm <= 10 ? 60 + norm * 4 : 500 + norm;
    return {
      x,
      y: 80 + offsetPx,
      angle: 0,
    };
  };
  return {
    isArcMode: true,
    pixelsPerBp: 4,
    rowHeight: 12,
    sequenceFontSize: 10,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offsetPx: number, halfHeight = 7) => {
      const start = posAt(startBp, offsetPx);
      const end = posAt(endBp, offsetPx);
      return [
        start.x,
        start.y - halfHeight,
        end.x,
        end.y - halfHeight,
        end.x,
        end.y + halfHeight,
        start.x,
        start.y + halfHeight,
      ];
    },
    isFeatureVisible: (startBp: number, featureLenBp: number) => {
      const mid = posAt(startBp + featureLenBp / 2, 0);
      return mid.x >= 0 && mid.x <= 200;
    },
  } as unknown as PathMapper;
}

function createVerticalCodonPath(): PathMapper {
  const posAt = (bp: number, offsetPx: number) => ({
    x: 100 + offsetPx,
    y: bp * 5,
    angle: Math.PI / 2,
  });
  return {
    isArcMode: true,
    pixelsPerBp: 5,
    rowHeight: 12,
    sequenceFontSize: 10,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offsetPx: number, halfHeight = 7) => {
      const start = posAt(startBp, offsetPx);
      const end = posAt(endBp, offsetPx);
      return [
        start.x - halfHeight,
        start.y,
        end.x - halfHeight,
        end.y,
        end.x + halfHeight,
        end.y,
        start.x + halfHeight,
        start.y,
      ];
    },
    isFeatureVisible: () => true,
  } as unknown as PathMapper;
}

function createFeature(direction: 'forward' | 'reverse' = 'forward'): Feature {
  return {
    id: 7,
    type: 'CDS',
    start: 10,
    end: 13,
    direction,
    displayName: 'codon',
    color: 0x3b82f6,
    lane: 0,
  };
}

function createCodon(): CodonInfo {
  return {
    startBp: 10,
    endBp: 13,
    codon: 'ATG',
    aa: 'M',
    isStop: false,
    isStart: true,
  };
}

function createSecondCodon(): CodonInfo {
  return {
    startBp: 13,
    endBp: 16,
    codon: 'GAA',
    aa: 'E',
    isStop: false,
    isStart: false,
  };
}

describe('CodonTrack', () => {
  it.each([
    { pixelsPerBp: 8, aaHeight: 18, aaFontSize: 14 },
    { pixelsPerBp: 9.6, aaHeight: 21.6, aaFontSize: 17 },
    { pixelsPerBp: 14, aaHeight: 31.5, aaFontSize: 24 },
  ])(
    'matches original Canvas CDS proportions at $pixelsPerBp pixels per base in stadium mode',
    ({ pixelsPerBp, aaHeight, aaFontSize }) => {
      const track = new CodonTrack(new Container());
      const wrapped = cdsReplacementZoomPresentation(pixelsPerBp, 655);
      const path = {
        ...createLinearPath(pixelsPerBp),
        isArcMode: true,
        sequenceFontSize: (pixelsPerBp * 11) / 7,
        rowHeight: (pixelsPerBp * 11) / 7 + 2,
      };
      track.renderCodons(createFeature(), [createCodon()], path, 0, 100, createState());
      const letter = (track as unknown as { letterPool: Text[] }).letterPool[0];
      expect(wrapped.aaHeight).toBeCloseTo(aaHeight, 8);
      expect(wrapped.aaFontSize).toBe(aaFontSize);
      const fontSize = aaFontSize;
      const target = getCodonLetterPosition(
        10 * pixelsPerBp,
        3 * pixelsPerBp,
        60 - wrapped.aaHeight / 2,
        wrapped.aaHeight,
        Math.round(wrapped.aaHeight * 0.17),
        1,
        fontSize
      );
      expect.soft(letter.x).toBeCloseTo(target.x, 8);
      expect.soft(letter.y).toBeCloseTo(target.y, 8);
      expect.soft(letter.style.fontSize).toBeCloseTo(fontSize, 8);
      expect.soft(letter.scale.x).toBe(1);
      expect.soft(letter.style.fill).toBe(0x000000);
      expect.soft(letter.alpha).toBe(1);
      const hit = (track as unknown as { hitCache: Array<{ yMin: number; yMax: number }> })
        .hitCache[0];
      expect.soft(hit.yMax - hit.yMin).toBeCloseTo(aaHeight, 8);
      const metrics = CanvasTextMetrics.measureFont(fontStringFromTextStyle(letter.style));

      const alphabeticBaseline =
        (metrics.ascent - letter.anchor.y * Math.ceil(metrics.fontSize)) * letter.scale.y;
      expect.soft(alphabeticBaseline).toBeCloseTo(fontSize * 0.25, 8);
      track.destroy();
    }
  );

  it('keeps amino-acid texture identity while zooming across glyph size boundaries', () => {
    const track = new CodonTrack(new Container());
    const textureKeys: string[] = [];
    try {
      for (const fontSize of [5.14, 6.85, 9.14, 11.53, 22, 5.14]) {
        track.reset();
        const path = {
          ...createLinearPath((fontSize * 7) / 11),
          sequenceFontSize: fontSize,
        };
        track.renderCodons(createFeature(), [createCodon()], path, 0, 100, createState());
        const letter = (track as unknown as { letterPool: Text[] }).letterPool[0];
        expect(letter.text).toBe('M');
        expect(letter.style.fontFamily).toBe(SEQUENCE_FONT_FAMILY);
        expect(letter.style.fontWeight).toBe(CODON_FONT_WEIGHT);
        expect(letter.style.fontSize * letter.scale.x).toBeCloseTo(
          codonFontSize(fontSize) * 0.92,
          6
        );
        expect(track.getDebugSnapshot()).toMatchObject({
          letterCount: 1,
          hitCount: 1,
          translationMismatchCount: 0,
        });
        textureKeys.push(letter.styleKey);
      }
      expect(new Set(textureKeys).size).toBe(1);
    } finally {
      track.destroy();
    }
  });

  it('bounds arbitrary draft letter colors with LRU reuse', () => {
    const track = new CodonTrack(new Container());
    const debug = track as unknown as {
      getDraftLetterStyle: (color: number) => object;
      draftLetterStyles: Map<number, object>;
    };
    const first = debug.getDraftLetterStyle(0);
    for (let color = 1; color < 64; color++) debug.getDraftLetterStyle(color);
    expect(debug.getDraftLetterStyle(0)).toBe(first);
    debug.getDraftLetterStyle(64);

    expect(debug.draftLetterStyles.size).toBe(64);
    expect(debug.getDraftLetterStyle(1)).not.toBe(first);
    expect(debug.getDraftLetterStyle(0)).toBe(first);
    track.destroy();
  });

  it('publishes chevron and hit counts through a stable debug snapshot', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);

    track.renderCodons(
      createFeature('forward'),
      [createCodon(), createSecondCodon()],
      path,
      0,
      100,
      createState()
    );

    expect(track.getDebugSnapshot()).toMatchObject({
      letterCount: 2,
      letterPoolSize: 2,
      semanticCodonCount: 2,
      distinctCodonCount: 2,
      distinctAminoAcidCount: 2,
      translationMismatchCount: 0,
      hitCount: 2,
      intronLabelCount: 0,
      curvedIntronLabelCount: 0,
    });

    track.reset();

    expect(track.getDebugSnapshot()).toMatchObject({
      letterCount: 0,
      letterPoolSize: 2,
      semanticCodonCount: 0,
      distinctCodonCount: 0,
      distinctAminoAcidCount: 0,
      translationMismatchCount: 0,
      hitCount: 0,
    });

    track.destroy();
  });

  it('bounds camera-frame graphics submissions by codon color instead of cell count', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const graphics = (
      track as unknown as {
        graphics: {
          fill: (...args: unknown[]) => void;
          stroke: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const strokeSpy = vi.spyOn(graphics, 'stroke');
    const codons = Array.from({ length: 10 }, (_, index): CodonInfo => {
      const startBp = 10 + index * 3;
      return {
        startBp,
        endBp: startBp + 3,
        codon: 'ATG',
        aa: 'M',
        isStop: false,
        isStart: index === 0,
        renderLetter: false,
      };
    });

    track.renderCodons(
      { ...createFeature('forward'), end: 40 },
      codons,
      path,
      0,
      100,
      createState()
    );

    expect(track.getDebugSnapshot().hitCount).toBe(10);
    expect(fillSpy).toHaveBeenCalledTimes(1);
    expect(strokeSpy).toHaveBeenCalledTimes(1);

    track.destroy();
  });

  it('aligns forward codon geometry to nucleotide boundaries, not base centers', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const calls: number[] = [];
    const path = createLinearPath(2, calls);

    track.renderCodons(createFeature('forward'), [createCodon()], path, 0, 100, createState());

    const hitCache = (
      track as unknown as {
        hitCache: Array<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
      }
    ).hitCache;

    expect(calls.slice(0, 3)).toEqual([11, 9.5, 12.5]);
    expect(hitCache).toHaveLength(1);
    expect(hitCache[0].xMin).toBeCloseTo(20, 5);
    expect(track.hitTest(20.25, 60)).toMatchObject({ start: 10, end: 12, featureId: 7 });
    expect(track.hitTest(19.75, 60)).toBeNull();

    track.destroy();
  });

  it('shrinks amino-acid letters while preserving codon chevron height and depth', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const graphics = (track as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    track.renderCodons(createFeature('forward'), [createCodon()], path, 0, 100, createState());

    const points = polySpy.mock.calls[0][0] as number[];
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    const trackHeight = path.rowHeight * 0.9;
    const chevronDepth = Math.round(trackHeight * 0.17);

    const letter = (track as unknown as { letterPool: Text[] }).letterPool[0];
    expect(letter.style.fontSize * letter.scale.x).toBeCloseTo(
      codonFontSize(path.sequenceFontSize) * 0.92,
      6
    );
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(trackHeight, 5);
    expect(Math.max(...xs) - points[2]).toBeCloseTo(chevronDepth, 5);

    track.destroy();
  });

  it('dims Plannotate review-gray CDS chevrons and amino acid letters', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const graphics = (
      track as unknown as {
        graphics: {
          fill: (...args: unknown[]) => void;
          setStrokeStyle: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const strokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');
    const feature = { ...createFeature('forward'), color: 0xe5e7eb };

    track.renderCodons(feature, [createCodon()], path, 0, 100, createState());

    const fillArg = fillSpy.mock.calls[0][0] as { alpha: number };
    const strokeArgs = strokeStyleSpy.mock.calls.map((call) => call[0] as { alpha: number });
    const debug = track as unknown as { letterPool: Array<{ alpha: number }>; letterIndex: number };

    expect(fillArg.alpha).toBeCloseTo(0.12, 5);
    expect(strokeArgs.some((arg) => Math.abs(arg.alpha - 0.06) < 1e-6)).toBe(true);
    expect(debug.letterIndex).toBe(1);
    expect(debug.letterPool[0].alpha).toBeCloseTo(0.17, 5);

    track.destroy();
  });

  it('keeps exact search-target amino glyphs canonical while graying later codon-layer siblings', () => {
    const targetParent = new Container();
    const targetTrack = new CodonTrack(targetParent);
    const path = createLinearPath(4);
    const state = createState();
    state.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-target',
    };
    const targetFeature = {
      ...createFeature('forward'),
      annotationTrackId: 'mRNA',
      canonicalIdentity: 'canonical-target',
    };
    const targetGraphics = (
      targetTrack as unknown as {
        graphics: {
          fill: (...args: unknown[]) => void;
          setStrokeStyle: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const targetFillSpy = vi.spyOn(targetGraphics, 'fill');

    targetTrack.renderCodons(targetFeature, [createCodon()], path, 0, 100, state);

    const targetFill = targetFillSpy.mock.calls[0][0] as { color: number; alpha: number };
    const targetDebug = targetTrack as unknown as {
      letterPool: Array<{ alpha: number; style: { fill: number } }>;
    };
    expect(targetFill.color).not.toBe(0x6b7280);
    expect(targetFill.alpha).toBeCloseTo(0.6, 5);
    expect(targetDebug.letterPool[0].alpha).toBeCloseTo(0.85, 5);
    expect(targetTrack.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusTargetCodonCellCount: 1,
      annotationSearchFocusDimmedCodonCellCount: 0,
    });

    const siblingParent = new Container();
    const siblingTrack = new CodonTrack(siblingParent);
    const siblingFeature = {
      ...createFeature('forward'),
      annotationTrackId: 'mRNA',
      canonicalIdentity: 'canonical-sibling',
    };
    const siblingGraphics = (
      siblingTrack as unknown as {
        graphics: {
          fill: (...args: unknown[]) => void;
          setStrokeStyle: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const siblingFillSpy = vi.spyOn(siblingGraphics, 'fill');
    const siblingStrokeSpy = vi.spyOn(siblingGraphics, 'setStrokeStyle');

    siblingTrack.renderCodons(siblingFeature, [createCodon()], path, 0, 100, state);

    expect(siblingFillSpy.mock.calls[0][0]).toEqual({
      color: 0x6b7280,
      alpha: 0.12,
    });
    expect(siblingStrokeSpy.mock.calls[0][0]).toEqual({
      width: 1.25,
      color: 0x6b7280,
      alpha: 0.06,
    });
    const siblingDebug = siblingTrack as unknown as {
      letterPool: Array<{ alpha: number; style: { fill: number } }>;
    };
    expect(siblingDebug.letterPool[0].alpha).toBeCloseTo(0.17, 5);
    expect(Number(siblingDebug.letterPool[0].style.fill)).toBe(0x6b7280);
    expect(siblingTrack.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusTargetCodonCellCount: 0,
      annotationSearchFocusDimmedCodonCellCount: 1,
    });

    targetTrack.destroy();
    siblingTrack.destroy();
  });

  it('does not gray codons from an annotation track outside the temporary search focus', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const state = createState();
    state.annotationSearchFocus = {
      trackId: 'lncRNA',
      canonicalIdentity: 'canonical-target',
    };
    const feature = {
      ...createFeature('forward'),
      annotationTrackId: 'mRNA',
      canonicalIdentity: 'canonical-sibling',
    };
    const graphics = (
      track as unknown as {
        graphics: { fill: (...args: unknown[]) => void };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');

    track.renderCodons(feature, [createCodon()], path, 0, 100, state);

    const fill = fillSpy.mock.calls[0][0] as { color: number; alpha: number };
    expect(fill.color).not.toBe(0x6b7280);
    expect(fill.alpha).toBeCloseTo(0.6, 5);
    expect(track.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusTargetCodonCellCount: 0,
      annotationSearchFocusDimmedCodonCellCount: 0,
    });

    track.destroy();
  });

  it('renders amino acid letters for vertical cap codons using path distance instead of x distance', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createVerticalCodonPath();

    track.renderCodons(createFeature('forward'), [createCodon()], path, 0, 100, createState());

    const debug = track as unknown as { letterIndex: number };
    expect(debug.letterIndex).toBe(1);

    track.destroy();
  });

  it('renders unchecked Plannotate CDS candidate chevrons as one wireframe strip', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const graphics = (
      track as unknown as {
        graphics: {
          fill: (...args: unknown[]) => void;
          poly: (...args: unknown[]) => void;
          lineTo: (...args: unknown[]) => void;
          setStrokeStyle: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const polySpy = vi.spyOn(graphics, 'poly');
    const lineToSpy = vi.spyOn(graphics, 'lineTo');
    const strokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');
    const feature = {
      ...createFeature('forward'),
      start: 10,
      end: 16,
      qualifiers: { source: 'pLannotate-draft', status: 'rejected' },
    };

    track.renderCodons(feature, [createCodon(), createSecondCodon()], path, 0, 100, createState());

    const strokeArgs = strokeStyleSpy.mock.calls.map((call) => call[0] as { alpha: number });
    const debug = track as unknown as { letterPool: Array<{ alpha: number }>; letterIndex: number };

    expect(fillSpy).not.toHaveBeenCalled();
    expect(polySpy).not.toHaveBeenCalled();
    expect(lineToSpy).toHaveBeenCalled();
    expect(strokeArgs.some((arg) => Math.abs(arg.alpha - 0.3) < 1e-6)).toBe(true);
    expect(strokeArgs.some((arg) => Math.abs(arg.alpha - 0.95) < 1e-6)).toBe(true);
    expect(debug.letterIndex).toBe(2);
    expect(debug.letterPool.every((letter) => Math.abs(letter.alpha - 0.3) < 1e-6)).toBe(true);

    track.destroy();
  });

  it('adds a dotted outline to filled pLannotate CDS candidate chevrons', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const graphics = (
      track as unknown as {
        graphics: {
          fill: (...args: unknown[]) => void;
          lineTo: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const lineToSpy = vi.spyOn(graphics, 'lineTo');
    const feature = {
      ...createFeature('forward'),
      start: 10,
      end: 16,
      qualifiers: { source: 'pLannotate-draft', status: 'accepted' },
    };

    track.renderCodons(feature, [createCodon(), createSecondCodon()], path, 0, 100, createState());

    expect(fillSpy).toHaveBeenCalled();
    expect(lineToSpy).toHaveBeenCalled();

    track.destroy();
  });

  it('draws one shared interaction outline around a hovered CDS chevron strip', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const state = createState();
    state.hoveredId = 7;
    const graphics = (
      track as unknown as {
        graphics: {
          poly: (...args: unknown[]) => void;
          setStrokeStyle: (...args: unknown[]) => void;
          stroke: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const strokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');
    const strokeSpy = vi.spyOn(graphics, 'stroke');

    track.renderCodons(createFeature('forward'), [createCodon()], path, 0, 100, state);

    const finalStyle = strokeStyleSpy.mock.calls.at(-1)?.[0] as {
      width: number;
      color: number;
      alpha: number;
    };
    const outlinePts = polySpy.mock.calls.at(-1)?.[0] as number[];

    expect(finalStyle).toEqual({ width: 1.5, color: 0x111827, alpha: 0.55 });
    expect(outlinePts.length).toBeGreaterThan(8);
    expect(strokeSpy).toHaveBeenCalledTimes(1);

    track.destroy();
  });

  it.each(['linear', 'circular'] as const)(
    'keeps separate coding segments separate in the %s compound hover perimeter',
    (mode) => {
      const track = new CodonTrack(new Container());
      const state = { ...createState(), hoveredId: 7 };
      const path = mode === 'circular' ? createArcPath() : createLinearPath(4);
      const codons = [
        { ...createCodon(), startBp: 0, endBp: 3 },
        { ...createCodon(), startBp: 10, endBp: 13 },
      ];
      for (const opacity of [0, 1]) {
        track.reset();
        const contours: number[][] = [];
        track.renderCodons(
          { ...createFeature(), start: 0, end: 16 },
          codons,
          path,
          0,
          100,
          state,
          opacity,
          0,
          Infinity,
          (points) => contours.push(points)
        );
        expect(contours).toHaveLength(opacity > 0 ? 2 : 0);
        expect(contours.every((points) => points.every(Number.isFinite))).toBe(true);
      }
      track.destroy();
    }
  );

  it('hands only a painted strip to its compound perimeter owner', () => {
    const track = new CodonTrack(new Container());
    const state = createState();
    state.selectedIds.add(7);
    const geometry: number[][] = [];
    for (const opacity of [1, 0.5, 0]) {
      track.reset();
      const receive = vi.fn((points: number[]) => geometry.push(points));
      track.renderCodons(
        createFeature(),
        [createCodon()],
        createLinearPath(4),
        0,
        100,
        state,
        opacity,
        0,
        Infinity,
        receive
      );
      expect(receive).toHaveBeenCalledTimes(opacity > 0 ? 1 : 0);
      if (opacity === 0)
        expect(track.getDebugSnapshot()).toMatchObject({ hitCount: 0, letterCount: 0 });
    }
    expect(geometry).toHaveLength(2);
    expect(geometry[0].length).toBeGreaterThan(8);
    expect(geometry[1]).toEqual(geometry[0]);
    track.destroy();
  });

  it('keeps the whole CDS strip outline while one hovered codon gets its Molstar-pink outline', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const state = createState();
    state.hoveredId = 7;
    state.hoveredCodon = { start: 10, end: 12, strand: 1 };
    const graphics = (
      track as unknown as {
        graphics: {
          setStrokeStyle: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const strokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');
    const compound = vi.fn();

    track.renderCodons(
      { ...createFeature('forward'), start: 10, end: 16 },
      [createCodon(), createSecondCodon()],
      path,
      0,
      100,
      state
    );
    track.reset();
    track.renderCodons(
      { ...createFeature('forward'), start: 10, end: 16 },
      [createCodon(), createSecondCodon()],
      path,
      0,
      100,
      state,
      1,
      0,
      Infinity,
      compound
    );

    const styles = strokeStyleSpy.mock.calls.map((call) => call[0]);
    expect(styles).toContainEqual({ width: 2.5, color: 0xff6699, alpha: 0.95 });
    expect(styles).toContainEqual({ width: 1.5, color: 0x111827, alpha: 0.55 });
    expect(compound).toHaveBeenCalledTimes(1);

    track.destroy();
  });

  it('draws a Molstar-green outline around structure-selected codon cells', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const state = createState();
    state.selectedCodons = [{ start: 10, end: 12, strand: 1 }];
    const graphics = (
      track as unknown as {
        graphics: {
          setStrokeStyle: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const strokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');

    track.renderCodons(
      { ...createFeature('forward'), start: 10, end: 16 },
      [createCodon(), createSecondCodon()],
      path,
      0,
      100,
      state
    );

    const styles = strokeStyleSpy.mock.calls.map((call) => call[0]);
    expect(styles).toContainEqual({ width: 2.5, color: 0x33ff1a, alpha: 0.95 });
    expect(track.getDebugSnapshot().selectedCodonCellCount).toBe(1);

    track.destroy();
  });

  it('extends the shared interaction outline around the full hovered CDS chevron run', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const state = createState();
    state.hoveredId = 7;
    const graphics = (
      track as unknown as {
        graphics: {
          poly: (...args: unknown[]) => void;
          setStrokeStyle: (...args: unknown[]) => void;
          stroke: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const feature = { ...createFeature('forward'), start: 10, end: 16 };

    track.renderCodons(feature, [createCodon(), createSecondCodon()], path, 0, 100, state);

    const outlinePts = polySpy.mock.calls.at(-1)?.[0] as number[];
    const xs = outlinePts.filter((_, index) => index % 2 === 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);

    expect(minX).toBeCloseTo(40, 5);
    expect(maxX).toBeGreaterThan(64);

    track.destroy();
  });

  it('orders reverse CDS chevrons visually before drawing the shared interaction outline', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(4);
    const state = createState();
    state.hoveredId = 7;
    const graphics = (
      track as unknown as {
        graphics: {
          poly: (...args: unknown[]) => void;
          setStrokeStyle: (...args: unknown[]) => void;
          stroke: (...args: unknown[]) => void;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const feature = { ...createFeature('reverse'), start: 10, end: 16 };

    track.renderCodons(feature, [createSecondCodon(), createCodon()], path, 0, 100, state);

    const outlinePts = polySpy.mock.calls.at(-1)?.[0] as number[];
    const xs = outlinePts.filter((_, index) => index % 2 === 0);

    expect(Math.min(...xs)).toBeCloseTo(38, 5);
    expect(Math.max(...xs)).toBeCloseTo(64, 5);

    track.destroy();
  });

  it('returns the full parent CDS range for codon hit records', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(2);
    const feature = { ...createFeature('forward'), start: 10, end: 40 };

    track.renderCodons(feature, [createCodon()], path, 0, 100, createState());

    expect(track.hitTest(20.25, 60)).toMatchObject({
      start: 10,
      end: 12,
      featureId: 7,
      featureStart: 10,
      featureEnd: 40,
      strand: 1,
    });

    track.destroy();
  });

  it('preserves reverse strand direction in codon hit records', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(2);
    const feature = { ...createFeature('reverse'), start: 10, end: 40 };

    track.renderCodons(feature, [createCodon()], path, 0, 100, createState());

    expect(track.hitTest(20.25, 60)).toMatchObject({
      start: 10,
      end: 12,
      strand: -1,
    });

    track.destroy();
  });

  it('hit-tests intron-split codon fragments as the full codon range', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createLinearPath(2);
    const feature = { ...createFeature('forward'), start: 0, end: 16 };
    const splitCodons: CodonInfo[] = [
      {
        startBp: 6,
        endBp: 7,
        codonStartBp: 6,
        codonEndBp: 11,
        codon: 'GCC',
        aa: 'A',
        isStop: false,
        isStart: false,
        renderLetter: false,
        isPartialPreIntron: true,
      },
      {
        startBp: 10,
        endBp: 12,
        codonStartBp: 6,
        codonEndBp: 11,
        codon: 'GCC',
        aa: 'A',
        isStop: false,
        isStart: false,
        renderLetter: true,
        isPartialPostIntron: true,
      },
    ];

    track.renderCodons(feature, splitCodons, path, 0, 100, createState());

    expect(track.hitTest(12.25, 60)).toMatchObject({
      start: 6,
      end: 11,
      featureId: 7,
      strand: 1,
    });
    expect(track.hitTest(20.25, 60)).toMatchObject({
      start: 6,
      end: 11,
      featureId: 7,
      strand: 1,
    });

    track.destroy();
  });

  it.each(['forward', 'reverse'] as const)(
    'draws uninterrupted %s intron connections aligned with codons without region pills',
    (direction) => {
      const track = new CodonTrack(new Container());
      const path = createLinearPath(20);
      const feature = { ...createFeature(direction), start: 0, end: 24 };
      const state = { ...createState(), width: 500 };
      resetLabelOccupancy(state);
      const graphics = (
        track as unknown as {
          graphics: {
            fill: (...args: unknown[]) => void;
            lineTo: (...args: unknown[]) => void;
            moveTo: (...args: unknown[]) => void;
          };
        }
      ).graphics;
      const fillSpy = vi.spyOn(graphics, 'fill');
      const lineToSpy = vi.spyOn(graphics, 'lineTo');
      const moveToSpy = vi.spyOn(graphics, 'moveTo');

      track.renderIntrons(
        feature,
        [
          {
            number: 1,
            genomicStart: 6,
            genomicEnd: 12,
            length: 7,
            phase: 0,
            donorSite: 'GT',
            acceptorSite: 'AG',
          },
        ],
        path,
        0,
        100,
        state
      );

      expect(track.getDebugSnapshot()).toMatchObject({
        intronLabelCount: 0,
        intronLabelPoolSize: 0,
        intronLabelSample: [],
        curvedIntronLabelCount: 0,
      });
      expect(fillSpy).not.toHaveBeenCalled();
      expect(getLabelOccupancyRecords(state)).toEqual([]);
      const depth = Math.round(path.rowHeight * 0.9 * 0.17);
      expect(moveToSpy).toHaveBeenCalledWith(120 + (direction === 'forward' ? depth : 0), 60);
      expect(lineToSpy).toHaveBeenCalledWith(260 - (direction === 'reverse' ? depth : 0), 60);
      track.destroy();
    }
  );

  it.each([createArcPath, createBottomArcPath])(
    'does not allocate circular intron pills or glyphs',
    (createPath) => {
      const track = new CodonTrack(new Container());
      track.renderIntrons(
        { ...createFeature(), start: 0, end: 30 },
        [
          {
            number: 1,
            genomicStart: 0,
            genomicEnd: 20,
            length: 21,
            phase: 0,
            donorSite: 'GT',
            acceptorSite: 'AG',
          },
        ],
        createPath(),
        0,
        100,
        { ...createState(), width: 300, height: 220 }
      );
      expect(track.getDebugSnapshot()).toMatchObject({
        intronLabelCount: 0,
        intronLabelPoolSize: 0,
        intronLabelSample: [],
        curvedIntronLabelCount: 0,
      });
      track.destroy();
    }
  );

  it('draws circular intron connectors along the lane path instead of as straight chords', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const path = createArcPath();
    const feature = { ...createFeature('forward'), start: 0, end: 30 };
    const graphics = (track as unknown as { graphics: { lineTo: (...args: unknown[]) => void } })
      .graphics;
    const lineToSpy = vi.spyOn(graphics, 'lineTo');

    track.renderIntrons(
      feature,
      [
        {
          number: 1,
          genomicStart: 0,
          genomicEnd: 20,
          length: 21,
          phase: 0,
          donorSite: 'GT',
          acceptorSite: 'AG',
        },
      ],
      path,
      0,
      100,
      createState()
    );

    const ys = lineToSpy.mock.calls.map((call) => Number(call[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);

    track.destroy();
  });

  it.each([
    ['linear', () => createLinearPath(8), 6, 12, [8, 10]],
    ['curved', createArcPath, 0, 20, [5, 15]],
    ['origin-spanning', () => createOriginWrappedArcPath([]), 90, 10, [95, 5]],
  ] as const)(
    'hit-tests only painted %s intron connectors without inventing codon selections',
    (_kind, createPath, start, end, positions) => {
      const track = new CodonTrack(new Container());
      const path = createPath();
      const feature = { ...createFeature(), start, end };
      const introns = [
        {
          number: 1,
          genomicStart: start,
          genomicEnd: end,
          length: ((end - start + 100) % 100) + 1,
          phase: 0,
          donorSite: 'GT',
          acceptorSite: 'AG',
        },
      ];
      const state = { ...createState(), width: 300, height: 220 };
      track.renderIntrons(feature, introns, path, 0, 100, state);
      for (const bp of positions) {
        const point = path.featureLabelPosAt(bp, 0);
        expect(track.hitTestIntron?.(point.x, point.y)).toEqual({ id: 7, start, end });
        expect(track.hitTest(point.x, point.y)).toBeNull();
        const normalX = -Math.sin(point.angle);
        const normalY = Math.cos(point.angle);
        expect(track.hitTestIntron?.(point.x + normalX * 8, point.y + normalY * 8)).toBeNull();
      }

      if (_kind === 'curved') expect(track.hitTestIntron?.(100, 100)).toBeNull();
      track.reset();
      const point = path.featureLabelPosAt(positions[0], 0);
      expect(track.hitTestIntron?.(point.x, point.y)).toBeNull();
      track.renderIntrons(feature, introns, path, 0, 100, state, 0);
      expect(track.hitTestIntron?.(point.x, point.y)).toBeNull();
      track.destroy();
    }
  );

  it('treats origin-spanning circular introns as one continuous wrapped lane span', () => {
    const parent = new Container();
    const track = new CodonTrack(parent);
    const calls: number[] = [];
    const path = createOriginWrappedArcPath(calls);
    const feature = { ...createFeature('forward'), start: 90, end: 10 };

    track.renderIntrons(
      feature,
      [
        {
          number: 1,
          genomicStart: 90,
          genomicEnd: 10,
          length: 21,
          phase: 0,
          donorSite: 'GT',
          acceptorSite: 'AG',
        },
      ],
      path,
      0,
      100,
      createState()
    );

    expect(Math.max(...calls)).toBeGreaterThan(100);
    expect(track.getDebugSnapshot().curvedIntronLabelCount).toBe(0);

    track.destroy();
  });
});

describe('alignment CDS difference rendering', () => {
  it.each([
    ['light', 'rasmol'],
    ['dark', 'rasmol'],
    ['light', 'none'],
    ['dark', 'none'],
  ] as const)('mutes wild-type chevrons with %s theme and %s palette', (themeMode, scheme) => {
    const axis = {
      biologicalLength: 9,
      bioToColumn: (base: number) => base,
      columnToBio: (column: number) => column,
    };
    const codons = compareProjectedCodons({
      reference: translateCDS('ATGAAATAA', 0, 9, 'forward', 9, false),
      referenceAxis: axis,
      query: translateCDS('ATGCAATAA', 0, 9, 'forward', 9, false),
      queryAxis: axis,
      columnLength: 9,
      direction: 'forward',
    });
    const track = new CodonTrack(new Container());
    const fill = vi.spyOn((track as unknown as { graphics: Graphics }).graphics, 'fill');
    track.renderCodons(
      { ...createFeature(), start: 0, end: 9, codingSource: 'query' },
      codons,
      createLinearPath(8),
      0,
      9,
      {
        ...createState(),
        themeMode,
        sequencePresentation: { cdsComparisonLayout: 'diff', aminoAcidColorScheme: scheme },
      }
    );
    expect(fill).toHaveBeenCalledWith({ color: 0x9e9e9e, alpha: 0.3 });
    expect(fill).toHaveBeenCalledWith({ color: 0xffc800, alpha: 1 });
    const letters = (track as unknown as { letterPool: Text[] }).letterPool.filter(
      (t) => t.visible
    );
    expect(letters.map((t) => t.text)).toEqual(['M', 'Q', '*']);
    expect(Number(letters[0].style.fill)).toBe(themeMode === 'dark' ? 0xb0b0b0 : 0x616161);
    expect(Number(letters[2].style.fill)).toBe(themeMode === 'dark' ? 0xb0b0b0 : 0x616161);
    track.destroy();
  });
  it.each([
    ['substitution', 'CAA', 0xffc800, false],
    ['inserted', 'CCC', 0x4caf50, false],
    ['frameshifted', 'CGT', 0xff9800, false],
    ['substitution', 'TAA', 0xf44336, true],
  ] as const)(
    'marks a non-wild-type %s %s across its whole chevron without another outline',
    (kind, dna, color, prematureStop) => {
      const codon = {
        ...translateCDS(dna, 0, 3, 'forward', 3, false)[0],
        mutation: {
          kind,
          referenceCodons: [{ codon: 'AAA', aa: 'K' }],
          referenceAa: 'K',
          queryAa: dna === 'TAA' ? '*' : undefined,
          frameShifted: kind === 'frameshifted',
          prematureStop,
          stopLost: false,
        },
      };
      const track = new CodonTrack(new Container());
      const graphics = (track as unknown as { graphics: Graphics }).graphics,
        fill = vi.spyOn(graphics, 'fill'),
        stroke = vi.spyOn(graphics, 'stroke');
      track.renderCodons(
        { ...createFeature(), start: 0, end: 3, codingSource: 'query' },
        [codon],
        createLinearPath(8),
        0,
        3,
        {
          ...createState(),
          sequencePresentation: { cdsComparisonLayout: 'diff', aminoAcidColorScheme: 'rasmol' },
        }
      );
      expect(fill).toHaveBeenCalledWith({ color, alpha: 1 });
      expect(stroke).toHaveBeenCalledTimes(1);
      const letters = (track as unknown as { letterPool: Text[] }).letterPool.filter(
        (t) => t.visible
      );
      expect(letters).toHaveLength(1);
      if (prematureStop) expect(Number(letters[0].style.fill)).toBe(0xffffff);
      track.destroy();
    }
  );
  it('keeps the original coding row uniformly muted with amino-acid coloring enabled', () => {
    const track = new CodonTrack(new Container());
    const graphics = (track as unknown as { graphics: Graphics }).graphics;
    const fill = vi.spyOn(graphics, 'fill');
    const original = { ...createFeature(), codingSource: 'reference' as const, color: 0x8b95a5 };
    track.renderCodons(
      original,
      [createCodon(), createSecondCodon()],
      createLinearPath(8),
      0,
      100,
      { ...createState(), sequencePresentation: { aminoAcidColorScheme: 'rasmol' } }
    );
    const paints = fill.mock.calls.map(([paint]) => paint);
    expect(
      paints.every(
        (paint) =>
          typeof paint === 'object' &&
          paint !== null &&
          'color' in paint &&
          paint.color === original.color &&
          'alpha' in paint &&
          typeof paint.alpha === 'number' &&
          paint.alpha <= 0.25
      )
    ).toBe(true);
    const letters = (track as unknown as { letterPool: Text[] }).letterPool.filter(
      (text) => text.visible
    );
    expect(letters.every((text) => text.style.fill === original.color && text.alpha < 0.8)).toBe(
      true
    );
    track.destroy();
  });
  it('adds no second cell-outline pass when adjacent codons differ', () => {
    const count = (changed: boolean) => {
      const track = new CodonTrack(new Container());
      const graphics = (track as unknown as { graphics: Graphics }).graphics;
      const stroke = vi.spyOn(graphics, 'stroke');
      const codons = [createCodon(), createSecondCodon()].map((codon) =>
        changed
          ? {
              ...codon,
              mutation: {
                kind: 'substitution' as const,
                referenceCodons: [{ codon: 'AAA', aa: 'K' }],
                referenceAa: 'K',
                queryAa: codon.aa,
                frameShifted: false,
                prematureStop: false,
                stopLost: false,
              },
            }
          : codon
      );
      track.renderCodons(createFeature(), codons, createLinearPath(8), 0, 100, createState());
      const result = stroke.mock.calls.length;
      track.destroy();
      return result;
    };
    expect(count(true)).toBe(count(false));
  });
  it('delegates the entire outer stroke to the compound CDS perimeter owner', () => {
    const track = new CodonTrack(new Container());
    const graphics = (track as unknown as { graphics: Graphics }).graphics;
    let pending: number[][] = [];
    const stroked: number[][] = [];
    const poly = graphics.poly.bind(graphics),
      fill = graphics.fill.bind(graphics),
      stroke = graphics.stroke.bind(graphics);
    vi.spyOn(graphics, 'poly').mockImplementation((...args) => {
      if (Array.isArray(args[0])) pending.push(args[0] as number[]);
      return poly(...args);
    });
    vi.spyOn(graphics, 'fill').mockImplementation((...args) => {
      pending = [];
      return fill(...args);
    });
    vi.spyOn(graphics, 'stroke').mockImplementation((...args) => {
      stroked.push(...pending);
      pending = [];
      return stroke(...args);
    });
    const state = createState();
    state.selectedIds.add(7);
    const owner = vi.fn();
    track.renderCodons(
      createFeature(),
      [createCodon(), createSecondCodon()],
      createLinearPath(8),
      0,
      100,
      state,
      1,
      0,
      Infinity,
      owner
    );
    expect(owner).toHaveBeenCalledTimes(1);
    expect(stroked).toEqual([]);
    track.destroy();
  });
  it('retains a newly introduced stop without adding another cell perimeter', () => {
    const axis = {
      biologicalLength: 9,
      bioToColumn: (base: number) => base,
      columnToBio: (column: number) => column,
    };
    const codons = compareProjectedCodons({
      reference: translateCDS('ATGAAATAA', 0, 9, 'forward', 9, false),
      referenceAxis: axis,
      query: translateCDS('ATGTAATAA', 0, 9, 'forward', 9, false),
      queryAxis: axis,
      columnLength: 9,
      direction: 'forward',
    });
    const track = new CodonTrack(new Container());
    const graphics = (track as unknown as { graphics: Graphics }).graphics;
    const stroke = vi.spyOn(graphics, 'setStrokeStyle');
    track.renderCodons(
      { ...createFeature('forward'), start: 0, end: 9 },
      codons,
      createLinearPath(8),
      0,
      9,
      createState()
    );
    expect(track.getDebugSnapshot()).toMatchObject({
      mutationCodonCount: 1,
      mutationKindCounts: { substitution: 1 },
    });
    expect(track.getDebugSnapshot().mutationSamples[0]).toMatchObject({
      referenceAa: 'K',
      queryAa: '*',
      prematureStop: true,
    });
    expect(stroke).toHaveBeenCalledTimes(1);
    expect(stroke).not.toHaveBeenCalledWith({ width: 2, color: 0xcc0000, alpha: 0.95 });
    expect(track.getDebugSnapshot().translationMismatchCount).toBe(0);
    track.destroy();
  });
  it('honors the amino-acid color chooser when property coloring is disabled', () => {
    const track = new CodonTrack(new Container());
    const graphics = (track as unknown as { graphics: Graphics }).graphics;
    const fill = vi.spyOn(graphics, 'fill');
    const codon = { ...createCodon(), codon: 'AAA', aa: 'K' };
    const feature = { ...createFeature('forward'), color: 0x2563eb };
    track.renderCodons(feature, [codon], createLinearPath(8), 0, 100, {
      ...createState(),
      sequencePresentation: { aminoAcidColorScheme: 'none' },
    });
    expect(fill).toHaveBeenCalledWith({ color: feature.color, alpha: 0.3 });
    track.destroy();
  });
});
