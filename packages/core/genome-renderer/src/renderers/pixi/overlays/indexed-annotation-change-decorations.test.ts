import { describe, expect, it, vi } from 'vitest';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { renderAnnotationChangeDecorations } from './indexed-annotation-change-decorations';
import type { OutlineCommand } from './annotation-feature-geometry';

function fixture() {
  const feature: Feature = {
    id: 7,
    start: 10,
    end: 30,
    type: 'CDS',
    direction: 'forward',
    displayName: 'coding feature',
    color: 0x80b0e0,
    lane: 0,
  };
  const commands: OutlineCommand[] = [
    { kind: 'poly', pts: [100, 10, 190, 10, 200, 15, 190, 20, 100, 20] },
    { kind: 'polyline', pts: [200, 15, 250, 15] },
    { kind: 'poly', pts: [250, 10, 290, 10, 300, 15, 290, 20, 250, 20] },
  ];
  const g = {
    setStrokeStyle: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    poly: vi.fn(),
    fill: vi.fn(),
  };
  const host = {
    featureById: new Map([[7, feature]]),
    outlineCache: new Map([[7, commands]]),
    invalidateCameraDependentInteractionOutline: vi.fn(),
    ensureInteractionOutline: vi.fn(),
  };
  const path = {
    isArcMode: false,
    viewStartBp: 0,
    viewEndBp: 100,
    pixelsPerBp: 10,
    bpLeftX: (p: number) => p * 10,
    scaleStroke: (p: number) => p,
  } as unknown as PathMapper;
  return { feature, commands, g, host, path };
}

describe('native annotation change decorations', () => {
  it('uses the native CDS/transcript outline and Canvas change dash without mutating scientific features', () => {
    const { g, host, path, feature, commands } = fixture();
    const result = renderAnnotationChangeDecorations(host, g as never, path, {
      annotationChangeDecorations: new Map([[7, { kind: 'modified' }]]),
    } as unknown as RenderState);
    expect(result.commandCount).toBe(3);
    expect(result.featureIds).toEqual([7]);
    expect(g.setStrokeStyle).toHaveBeenCalledWith({ width: 1.75, color: 0x4474a4, alpha: 1 });
    expect(g.moveTo).toHaveBeenCalled();
    expect(g.lineTo).toHaveBeenCalled();
    expect(g.fill).not.toHaveBeenCalled();
    expect(feature.color).toBe(0x80b0e0);
    expect(host.outlineCache.get(7)).toBe(commands);
  });
  it('clips range markup to each exact exon polygon rather than filling the intervening intron', () => {
    const { g, host, path } = fixture();
    const result = renderAnnotationChangeDecorations(host, g as never, path, {
      annotationChangeDecorations: new Map([
        [7, { kind: 'modified', color: 0xf0c020, ranges: [{ start: 18, end: 27 }] }],
      ]),
    } as unknown as RenderState);
    expect(result.commandCount).toBe(3);
    expect(g.poly.mock.calls).toHaveLength(2);
    for (const [pts] of g.poly.mock.calls)
      expect(
        (pts as number[]).filter((_, i) => i % 2 === 0).every((x) => x >= 180 && x <= 270)
      ).toBe(true);
    expect(g.fill).toHaveBeenCalledTimes(2);
  });
  it('marks a supplied removed ghost with red wash and native-shape strike without changing hit data', () => {
    const { g, host, path } = fixture();
    const result = renderAnnotationChangeDecorations(host, g as never, path, {
      annotationChangeDecorations: new Map([[7, { kind: 'removed' }]]),
    } as unknown as RenderState);
    expect(result.featureIds).toEqual([7]);
    expect(g.fill).toHaveBeenCalledWith({ color: 0xdf3a3a, alpha: 0.16 });
    expect(g.stroke).toHaveBeenCalled();
    expect(host.featureById.size).toBe(1);
  });
  it('does no native feature lookup or geometry work when changes are absent, and skips unknown IDs', () => {
    const { g, host, path } = fixture();
    expect(
      renderAnnotationChangeDecorations(host, g as never, path, {} as unknown as RenderState)
    ).toEqual({
      commandCount: 0,
      featureIds: [],
    });
    expect(host.ensureInteractionOutline).not.toHaveBeenCalled();
    expect(g.setStrokeStyle).not.toHaveBeenCalled();
    expect(
      renderAnnotationChangeDecorations(host, g as never, path, {
        annotationChangeDecorations: new Map([[999, { kind: 'added' }]]),
      } as unknown as RenderState)
    ).toEqual({ commandCount: 0, featureIds: [] });
  });
});

describe('ordinary sequence annotation owner', () => {
  it('paints change markup without hover, keeps normal selection, and clears it after leaving the changelog', async () => {
    const { SequenceAnnotationOverlay } = await import('./sequence-annotation-overlay');
    const { feature, commands, path } = fixture();
    const overlay = new SequenceAnnotationOverlay();
    overlay.loadGenome({
      name: 'recorded local product',
      length: 100,
      circular: false,
      features: [feature],
    });
    Reflect.get(overlay, 'outlineCache').set(feature.id, commands);
    const render = Reflect.get(overlay, 'renderInteractionOutlines').bind(overlay);
    const state = {
      selectedIds: new Set<number>(),
      hoveredId: null,
      annotationChangeDecorations: new Map([[7, { kind: 'modified' }]]),
    } as unknown as RenderState;
    render(path, state);
    expect(Reflect.get(overlay, 'getChangeDecorationSnapshot').call(overlay)).toEqual({
      commandCount: 3,
      featureIds: [7],
    });
    expect(Reflect.get(overlay, 'interactionGraphics').visible).toBe(false);
    render(path, { ...state, selectedIds: new Set([7]) });
    expect(Reflect.get(overlay, 'interactionGraphics').visible).toBe(true);
    expect(Reflect.get(overlay, 'getChangeDecorationSnapshot').call(overlay).commandCount).toBe(3);
    render(path, { ...state, annotationChangeDecorations: undefined });
    expect(Reflect.get(overlay, 'getChangeDecorationSnapshot').call(overlay)).toEqual({
      commandCount: 0,
      featureIds: [],
    });
    expect(Reflect.get(overlay, 'changeDecorationGraphics').visible).toBe(false);
    overlay.destroy();
  });
});
