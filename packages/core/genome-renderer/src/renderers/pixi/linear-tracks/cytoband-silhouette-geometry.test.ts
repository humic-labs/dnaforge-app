import { describe, expect, it } from 'vitest';

import {
  computeBetweenMemberSilhouetteGeometry,
  computeCapsuleSilhouetteGeometry,
  computeCentromereBoundarySilhouetteGeometry,
  computeChromosomeSilhouetteGeometry,
  computeSchematicChromosomeSilhouetteGeometry,
} from './cytoband-silhouette-geometry';

describe('computeChromosomeSilhouetteGeometry', () => {
  it('keeps p arm, centromere, and q arm proportional to genomic coordinates', () => {
    const geometry = computeChromosomeSilhouetteGeometry({
      leftPx: 100,
      widthPx: 400,
      heightPx: 14,
      chromosomeLengthBp: 1_000,
      centromere: { startBp: 250, endBp: 350 },
    });

    expect(geometry).toMatchObject({
      leftPx: 100,
      rightPx: 500,
      centromereStartPx: 200,
      centromereEndPx: 240,
      centromereMidpointPx: 220,
      pArmWidthPx: 100,
      centromereWidthPx: 40,
      qArmWidthPx: 260,
      topPx: 0,
      bottomPx: 14,
    });
  });

  it('uses fixed-pixel telomere and centromere curves when both arms have room', () => {
    const geometry = computeChromosomeSilhouetteGeometry({
      leftPx: 0,
      widthPx: 240,
      heightPx: 14,
      chromosomeLengthBp: 1_000,
      centromere: { startBp: 400, endBp: 460 },
    });

    expect(geometry).not.toBeNull();
    if (!geometry) throw new Error('Expected valid silhouette geometry');
    expect(geometry.pTelomereRadiusPx).toBe(7);
    expect(geometry.qTelomereRadiusPx).toBe(7);
    expect(geometry.pCentromereCurveReachPx).toBe(10);
    expect(geometry.qCentromereCurveReachPx).toBe(10);
    expect(geometry.pTaperStartPx).toBeLessThan(geometry.centromereStartPx);
    expect(geometry.qTaperEndPx).toBeGreaterThan(geometry.centromereEndPx);
    expect(geometry.centromereStartPx - geometry.pTaperStartPx).toBeGreaterThan(0);
    expect(geometry.qTaperEndPx - geometry.centromereEndPx).toBeGreaterThan(0);
    expect(geometry.centromereMidpointPx).toBe(
      (geometry.centromereStartPx + geometry.centromereEndPx) / 2
    );
    expect(geometry.waistTopPx).toBe(2.25);
    expect(geometry.waistBottomPx).toBe(11.75);
  });

  it('compresses only the short arm while preserving the target curvature on the long arm', () => {
    const geometry = computeChromosomeSilhouetteGeometry({
      leftPx: 0,
      widthPx: 90,
      heightPx: 14,
      chromosomeLengthBp: 1_000,
      centromere: { startBp: 100, endBp: 160 },
    });

    expect(geometry).not.toBeNull();
    if (!geometry) throw new Error('Expected valid silhouette geometry');
    expect(geometry.pTelomereRadiusPx).toBeLessThan(7);
    expect(geometry.pCentromereCurveReachPx).toBeLessThan(10);
    expect(geometry.qTelomereRadiusPx).toBe(7);
    expect(geometry.qCentromereCurveReachPx).toBe(10);
    expect(geometry.pTaperStartPx).toBeCloseTo(geometry.leftPx + geometry.pTelomereRadiusPx);
  });

  it.each([
    ['terminal-start', 110, 3_000, 0, 7],
    ['terminal-end', 7_000, 9_900, 7, 0],
  ] as const)(
    'makes a circular terminal cap mutually tangent with the %s taper',
    (topology, startBp, endBp, expectedLeftRadius, expectedRightRadius) => {
      const geometry = computeChromosomeSilhouetteGeometry({
        leftPx: 0,
        widthPx: 120,
        heightPx: 14,
        chromosomeLengthBp: 10_000,
        centromere: { startBp, endBp },
        topology,
      });

      expect(geometry).not.toBeNull();
      expect(geometry?.pTelomereRadiusPx).toBe(expectedLeftRadius);
      expect(geometry?.qTelomereRadiusPx).toBe(expectedRightRadius);
      expect(geometry?.centromereMidpointPx).toBe(
        topology === 'terminal-start' ? geometry?.leftPx : geometry?.rightPx
      );
      const terminalCap = (
        geometry as unknown as {
          terminalCap: {
            radiusPx: number;
            centerXPx: number;
            centerYPx: number;
            tipXPx: number;
            upperTangentXPx: number;
            upperTangentYPx: number;
            lowerTangentXPx: number;
            lowerTangentYPx: number;
            bodyAnchorXPx: number;
            arcControlReachPx: number;
          } | null;
        }
      ).terminalCap;
      expect(terminalCap).not.toBeNull();
      if (!terminalCap) throw new Error('Expected terminal cap geometry');
      expect(terminalCap.radiusPx).toBe(4);
      expect(terminalCap.tipXPx).toBe(topology === 'terminal-start' ? 0 : 120);
      expect(terminalCap.upperTangentYPx).toBeLessThan(terminalCap.centerYPx);
      expect(terminalCap.lowerTangentYPx).toBeGreaterThan(terminalCap.centerYPx);
      expect(terminalCap.lowerTangentXPx).toBeCloseTo(terminalCap.upperTangentXPx);
      expect(terminalCap.arcControlReachPx).toBeGreaterThan(0);

      const radialX = terminalCap.upperTangentXPx - terminalCap.centerXPx;
      const radialY = terminalCap.upperTangentYPx - terminalCap.centerYPx;
      const shoulderX = terminalCap.bodyAnchorXPx - terminalCap.upperTangentXPx;
      const shoulderY = geometry!.topPx - terminalCap.upperTangentYPx;
      expect(Math.hypot(radialX, radialY)).toBeCloseTo(terminalCap.radiusPx);
      expect(radialX * shoulderX + radialY * shoulderY).toBeCloseTo(0);
      expect(
        topology === 'terminal-start'
          ? geometry!.qTaperEndPx - geometry!.leftPx
          : geometry!.rightPx - geometry!.pTaperStartPx
      ).toBe(10);
    }
  );

  it.each(['terminal-start', 'terminal-end'] as const)(
    'keeps a %s cap inside an ultra-short chromosome member',
    (topology) => {
      const leftPx = 25;
      const widthPx = 6;
      const geometry = computeChromosomeSilhouetteGeometry({
        leftPx,
        widthPx,
        heightPx: 14,
        chromosomeLengthBp: 1_000,
        centromere:
          topology === 'terminal-start' ? { startBp: 1, endBp: 100 } : { startBp: 900, endBp: 999 },
        topology,
      });

      expect(geometry?.terminalCap).not.toBeNull();
      const terminalCap = geometry?.terminalCap;
      if (!terminalCap) throw new Error('Expected terminal cap geometry');
      for (const x of [
        terminalCap.centerXPx,
        terminalCap.tipXPx,
        terminalCap.upperTangentXPx,
        terminalCap.lowerTangentXPx,
      ]) {
        expect(x).toBeGreaterThanOrEqual(leftPx);
        expect(x).toBeLessThanOrEqual(leftPx + widthPx);
      }
    }
  );

  it('builds one smooth waist at an adjoining chromosome-arm boundary', () => {
    const geometry = computeBetweenMemberSilhouetteGeometry({
      leftPx: 10,
      leftMemberWidthPx: 80,
      rightMemberWidthPx: 120,
      heightPx: 14,
    });

    expect(geometry).toMatchObject({
      leftPx: 10,
      rightPx: 210,
      centromereStartPx: 90,
      centromereEndPx: 90,
      centromereMidpointPx: 90,
      pTelomereRadiusPx: 7,
      qTelomereRadiusPx: 7,
    });
  });

  it.each([
    [300, 'internal', 120],
    [0, 'terminal-start', 0],
    [1_000, 'terminal-end', 400],
  ] as const)(
    'projects an exact zero-width centromere boundary at %s bp',
    (positionBp, topology, expectedMidpointPx) => {
      const geometry = computeCentromereBoundarySilhouetteGeometry({
        leftPx: 0,
        widthPx: 400,
        heightPx: 14,
        chromosomeLengthBp: 1_000,
        positionBp,
        topology,
      });

      expect(geometry).toMatchObject({
        topology,
        centromereStartPx: expectedMidpointPx,
        centromereEndPx: expectedMidpointPx,
        centromereMidpointPx: expectedMidpointPx,
        centromereWidthPx: 0,
      });
    }
  );

  it('uses the same rounded capsule curvature for holocentric chromosomes of different lengths', () => {
    const short = computeCapsuleSilhouetteGeometry({ leftPx: 0, widthPx: 40, heightPx: 14 });
    const long = computeCapsuleSilhouetteGeometry({ leftPx: 0, widthPx: 400, heightPx: 14 });

    expect(short).toMatchObject({ leftPx: 0, rightPx: 40, radiusPx: 7 });
    expect(long).toMatchObject({ leftPx: 0, rightPx: 400, radiusPx: 7 });
  });

  it('caps the centromere taper to a compact fixed-pixel reach on very wide chromosomes', () => {
    const geometry = computeChromosomeSilhouetteGeometry({
      leftPx: 0,
      widthPx: 4_000,
      heightPx: 14,
      chromosomeLengthBp: 1_000,
      centromere: { startBp: 480, endBp: 520 },
    });

    expect(geometry?.pCentromereCurveReachPx).toBe(10);
    expect(geometry?.qCentromereCurveReachPx).toBe(10);
  });

  it.each([
    ['metacentric', 'start', 0.5, 'internal'],
    ['submetacentric', 'start', 0.32, 'internal'],
    ['acrocentric', 'start', 0.1, 'internal'],
    ['acrocentric', 'end', 0.9, 'internal'],
    ['telocentric', 'start', 0, 'terminal-start'],
    ['telocentric', 'end', 1, 'terminal-end'],
  ] as const)(
    'uses a stable %s visual class facing %s without genomic coordinates',
    (centromereClass, shortArmAt, midpointRatio, topology) => {
      const geometry = computeSchematicChromosomeSilhouetteGeometry({
        leftPx: 20,
        widthPx: 200,
        heightPx: 14,
        centromereClass,
        shortArmAt,
      });

      expect(geometry).not.toBeNull();
      expect(geometry?.topology).toBe(topology);
      expect(geometry?.centromereMidpointPx).toBeCloseTo(20 + 200 * midpointRatio);
    }
  );

  it.each([
    { chromosomeLengthBp: 0, centromere: { startBp: 10, endBp: 20 } },
    { chromosomeLengthBp: 100, centromere: { startBp: 0, endBp: 20 } },
    { chromosomeLengthBp: 100, centromere: { startBp: 20, endBp: 20 } },
    { chromosomeLengthBp: 100, centromere: { startBp: 80, endBp: 100 } },
    { chromosomeLengthBp: 100, centromere: { startBp: 90, endBp: 101 } },
    { chromosomeLengthBp: 100, centromere: { startBp: Number.NaN, endBp: 50 } },
  ])('returns null for invalid normalized geometry %#', ({ chromosomeLengthBp, centromere }) => {
    expect(
      computeChromosomeSilhouetteGeometry({
        leftPx: 0,
        widthPx: 100,
        heightPx: 14,
        chromosomeLengthBp,
        centromere,
      })
    ).toBeNull();
  });
});
