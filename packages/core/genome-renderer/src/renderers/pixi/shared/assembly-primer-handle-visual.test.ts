import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_PRIMER_HANDLE_METRICS,
  assemblyPrimerHandleContainsPoint,
  assemblyPrimerHandleGeometry,
  assemblyPrimerHandleVisualForMode,
} from './assembly-primer-handle-visual';

describe('assembly primer handle visual contract', () => {
  it('pins the drawer grip metrics and both theme palettes', () => {
    expect(ASSEMBLY_PRIMER_HANDLE_METRICS).toEqual({
      hitWidthPx: 28,
      hitHeightPx: 22,
      guideLengthPx: 13,
      guideWidthPx: 1,
      guideDashPx: 2,
      guideGapPx: 3,
      gripWidthPx: 16,
      gripHeightPx: 7,
      gripRadiusPx: 5,
      gripBorderWidthPx: 1,
    });
    expect(assemblyPrimerHandleVisualForMode('light')).toMatchObject({
      contractId: 'assembly-primer-handle-v1',
      strokeColor: 0x686663,
      guideColor: 0xa8a6a2,
      gripFillColor: 0xc4c3c2,
      gripBorderColor: 0x757471,
      gripFillColorCss: 'rgb(196, 195, 194)',
    });
    expect(assemblyPrimerHandleVisualForMode('dark')).toMatchObject({
      contractId: 'assembly-primer-handle-v1',
      strokeColor: 0xa9a7a3,
      guideColor: 0x67635c,
      gripFillColor: 0x4e4c4a,
      gripBorderColor: 0x9c9a97,
      gripFillColorCss: 'rgb(78, 76, 74)',
    });
  });

  it('rotates the drawer geometry as one rigid shape and hit-tests its full dock area', () => {
    const geometry = assemblyPrimerHandleGeometry({
      anchorX: 100,
      anchorY: 50,
      angle: Math.PI / 2,
    });
    expect(geometry.guideEnd).toEqual({ x: 87, y: 50 });
    expect(geometry.gripCenter).toEqual({ x: 83.5, y: 50 });
    expect(
      assemblyPrimerHandleContainsPoint(geometry, {
        x: geometry.gripCenter.x,
        y: geometry.gripCenter.y,
      })
    ).toBe(true);
    expect(assemblyPrimerHandleContainsPoint(geometry, { x: 87, y: 64 })).toBe(true);
    expect(assemblyPrimerHandleContainsPoint(geometry, { x: 87, y: 64.01 })).toBe(false);
    expect(assemblyPrimerHandleContainsPoint(geometry, { x: 75.99, y: 50 })).toBe(false);
  });
});
