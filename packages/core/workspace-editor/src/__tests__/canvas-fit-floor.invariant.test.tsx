// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { parseGenBankFull } from '@waypoint/sequence-utils';
import { useSequenceLayout } from '../useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  computeCanvasFitOnceMinZoom,
  deriveSequenceLodLevel,
} from '../zoom-math';

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');
const MG1655 = join(FIXTURES_DIR, 'sequences/circular/ecoli-mg1655-complete.gb');
const PUC19 = join(FIXTURES_DIR, 'sequences/circular/pUC19.gb');
const ECOLI_REGION = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');
const PERF_MEDIUM = join(FIXTURES_DIR, 'sequences/circular/perf-medium-synthetic.gb');
const TINY_LINEAR = join(FIXTURES_DIR, 'sequences/linear/mg1655-thrL-multi-xref-synthetic.gb');

function loadFixture(path: string) {
  return parseGenBankFull(readFileSync(path, 'utf8'));
}

function configAtZoom(zoom: number, containerWidth: number): WorkspaceEditorConfig {
  const scale = zoom / 100;
  const charWidth = DEFAULT_EDITOR_CONFIG.charWidth * scale;
  const rowHeight = DEFAULT_EDITOR_CONFIG.rowHeight * scale;
  const fontSize = DEFAULT_EDITOR_CONFIG.fontSize * scale;
  const usable = containerWidth - DEFAULT_EDITOR_CONFIG.marginLeft;
  const charsPerLine = Math.max(10, Math.floor(usable / Math.max(charWidth, 0.1)));
  const lodLevel = deriveSequenceLodLevel({ charWidth, rowHeight, fontSize });
  const isDetail = lodLevel === 'detail';
  return {
    ...DEFAULT_EDITOR_CONFIG,
    charWidth,
    rowHeight,
    fontSize,
    charsPerLine,
    lodLevel,
    showTranslation: isDetail ? DEFAULT_EDITOR_CONFIG.showTranslation : false,
    showReverseComplement: isDetail ? DEFAULT_EDITOR_CONFIG.showReverseComplement : false,
    showPrimers: lodLevel !== 'density' ? DEFAULT_EDITOR_CONFIG.showPrimers : false,
    showResidueNumbers: isDetail ? DEFAULT_EDITOR_CONFIG.showResidueNumbers : false,
  };
}

interface FrameSnapshot {
  zoom: number;
  realContentHeight: number;
  invariant: boolean;
  latched: number | null;
  floor: number;
  zoomAfterSnap: number;
}

function simulateRenderLoop(
  sequence: ReturnType<typeof loadFixture>,
  initialZoom: number,
  containerWidth: number,
  viewportHeight: number,
  isCircular: boolean,
  maxIterations: number = 16
): FrameSnapshot[] {
  const frames: FrameSnapshot[] = [];
  let zoom = initialZoom;

  for (let i = 0; i < maxIterations; i += 1) {
    const config = configAtZoom(zoom, containerWidth);
    const { result } = renderHook(() => useSequenceLayout(sequence, config));
    const snapshot = result.current.snapshot;
    const realContentHeight =
      snapshot.realRowsStartY !== undefined && snapshot.bottomBufferStartY !== undefined
        ? Math.max(0, snapshot.bottomBufferStartY - snapshot.realRowsStartY)
        : snapshot.totalHeight;
    const invariant = realContentHeight >= viewportHeight;

    let floor: number;
    if (!isCircular) {
      floor = MIN_ZOOM;
    } else if (invariant || viewportHeight <= 0) {
      floor = MIN_ZOOM;
    } else {
      floor = computeCanvasFitOnceMinZoom({
        observedHeight: realContentHeight,
        observedZoom: zoom,
        viewportHeight,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
      });
    }

    let zoomAfterSnap = zoom;
    const inSafeZone = realContentHeight >= viewportHeight && viewportHeight > 0;
    if (!inSafeZone && zoom < floor - 0.001) {
      zoomAfterSnap = floor;
    }

    frames.push({
      zoom,
      realContentHeight,
      invariant,
      latched: null,
      floor,
      zoomAfterSnap,
    });

    if (zoomAfterSnap === zoom) break;
    zoom = zoomAfterSnap;
  }
  return frames;
}

function simulateUserWheel(
  sequence: ReturnType<typeof loadFixture>,
  isCircular: boolean,
  containerWidth: number,
  viewportHeight: number,
  zoomTargets: number[]
): FrameSnapshot[] {
  const landings: FrameSnapshot[] = [];
  for (const target of zoomTargets) {
    const trajectory = simulateRenderLoop(
      sequence,
      target,
      containerWidth,
      viewportHeight,
      isCircular
    );
    landings.push(trajectory[trajectory.length - 1]);
  }
  return landings;
}

interface MatrixRow {
  name: string;
  fixture: string;
  isCircular: boolean;
  containerWidth: number;
  viewportHeight: number;
  initialZoom: number;
  expected: 'solvable' | 'unsolvable' | 'inactive' | 'linear-no-floor';
  solvableTolerancePx?: number;
}

const MATRIX: MatrixRow[] = [
  {
    name: 'pUC19 (2.7kb circular) — 1200×600, start at zoom 1% (heavy duplication regime)',
    fixture: PUC19,
    isCircular: true,
    containerWidth: 1200,
    viewportHeight: 600,
    initialZoom: 1,
    expected: 'solvable',
    solvableTolerancePx: 0,
  },
  {
    name: 'pUC19 (2.7kb circular) — 1200×600, start at MIN_ZOOM',
    fixture: PUC19,
    isCircular: true,
    containerWidth: 1200,
    viewportHeight: 600,
    initialZoom: MIN_ZOOM,
    expected: 'solvable',
    solvableTolerancePx: 0,
  },
  {
    name: 'pUC19 (2.7kb circular) — 1200×300',
    fixture: PUC19,
    isCircular: true,
    containerWidth: 1200,
    viewportHeight: 300,
    initialZoom: 1,
    expected: 'solvable',
    solvableTolerancePx: 0,
  },
  {
    name: 'pUC19 (2.7kb circular) — 1200×1200 (taller viewport)',
    fixture: PUC19,
    isCircular: true,
    containerWidth: 1200,
    viewportHeight: 1200,
    initialZoom: 1,
    expected: 'solvable',
    solvableTolerancePx: 0,
  },
  {
    name: 'perf-medium (11kb circular) — 1200×600',
    fixture: PERF_MEDIUM,
    isCircular: true,
    containerWidth: 1200,
    viewportHeight: 600,
    initialZoom: MIN_ZOOM,
    expected: 'solvable',
    solvableTolerancePx: 0,
  },
  {
    name: 'MG1655 complete (4.6Mb circular) — 1800×800 from old 2.5% floor',
    fixture: MG1655,
    isCircular: true,
    containerWidth: 1800,
    viewportHeight: 800,
    initialZoom: 2.5,
    expected: 'inactive',
  },
  {
    name: 'ecoli-mg1655-region (78kb linear) — 1200×600 from MIN_ZOOM',
    fixture: ECOLI_REGION,
    isCircular: false,
    containerWidth: 1200,
    viewportHeight: 600,
    initialZoom: MIN_ZOOM,
    expected: 'linear-no-floor',
  },
  {
    name: 'ecoli-mg1655-region (78kb linear) — 1200×300 from zoom 50%',
    fixture: ECOLI_REGION,
    isCircular: false,
    containerWidth: 1200,
    viewportHeight: 300,
    initialZoom: 50,
    expected: 'linear-no-floor',
  },
  {
    name: 'tiny linear 300bp — 1200×600 (small linear, no floor regardless)',
    fixture: TINY_LINEAR,
    isCircular: false,
    containerWidth: 1200,
    viewportHeight: 600,
    initialZoom: 1,
    expected: 'linear-no-floor',
  },
  {
    name: 'tiny linear 300bp — 1200×100',
    fixture: TINY_LINEAR,
    isCircular: false,
    containerWidth: 1200,
    viewportHeight: 100,
    initialZoom: MIN_ZOOM,
    expected: 'linear-no-floor',
  },
];

describe('canvas fit-once floor — full regime matrix', () => {
  for (const row of MATRIX) {
    it(`${row.name} → ${row.expected}`, () => {
      const sequence = loadFixture(row.fixture);
      const trajectory = simulateRenderLoop(
        sequence,
        row.initialZoom,
        row.containerWidth,
        row.viewportHeight,
        row.isCircular,
        20
      );
      const final = trajectory[trajectory.length - 1];

      const trace = trajectory
        .map(
          (f) =>
            `z=${f.zoom.toFixed(2)} h=${f.realContentHeight.toFixed(0)} latch=${f.latched ?? 'null'} floor=${f.floor.toFixed(2)} → ${f.zoomAfterSnap.toFixed(2)}`
        )
        .join(' | ');
      expect(trajectory.length, `oscillation? ${trace}`).toBeLessThan(20);

      switch (row.expected) {
        case 'solvable': {
          const tolerance = row.solvableTolerancePx ?? 0;
          expect(
            final.realContentHeight + tolerance,
            `final realH=${final.realContentHeight} should be ≥ viewport=${row.viewportHeight}; trajectory: ${trace}`
          ).toBeGreaterThanOrEqual(row.viewportHeight);
          break;
        }
        case 'unsolvable': {
          expect(final.zoomAfterSnap).toBe(MAX_ZOOM);
          expect(final.realContentHeight).toBeLessThan(row.viewportHeight);
          break;
        }
        case 'inactive': {
          for (const frame of trajectory) {
            expect(frame.invariant).toBe(true);
            expect(frame.zoomAfterSnap).toBeLessThanOrEqual(frame.zoom + 0.001);
          }
          break;
        }
        case 'linear-no-floor': {
          for (const frame of trajectory) {
            expect(
              frame.floor,
              `linear fixture floor must stay at MIN_ZOOM (got ${frame.floor})`
            ).toBe(MIN_ZOOM);
            expect(
              frame.zoomAfterSnap,
              `linear fixture snap-up must never bump zoom (zoom=${frame.zoom} → ${frame.zoomAfterSnap})`
            ).toBe(frame.zoom);
          }
          break;
        }
      }
    });
  }
});

describe('canvas fit-once floor — user wheel-out regression for stale-floor race', () => {
  it('S288C-style LARGE LINEAR fixture: wheeling all the way out from zoom 100 lands at every requested zoom (floor never engages)', () => {
    const sequence = loadFixture(ECOLI_REGION);
    const containerWidth = 1200;
    const viewportHeight = 600;
    const wheelTargets = [100, 80, 50, 25, 10, 5, 1, MIN_ZOOM];
    const landings = simulateUserWheel(
      sequence,
      false,
      containerWidth,
      viewportHeight,
      wheelTargets
    );
    for (let i = 0; i < wheelTargets.length; i += 1) {
      expect(
        landings[i].zoomAfterSnap,
        `wheel target ${wheelTargets[i]} but landed at ${landings[i].zoomAfterSnap}`
      ).toBe(wheelTargets[i]);
    }
  });

  it('LARGE CIRCULAR fixture: wheeling from zoom 100 down to MIN_ZOOM lands at every step until the actual fit boundary', () => {
    const sequence = loadFixture(PERF_MEDIUM);
    const containerWidth = 1200;
    const viewportHeight = 300;
    const wheelTargets = [100, 80, 50, 25, 10, 5];
    const landings = simulateUserWheel(
      sequence,
      true,
      containerWidth,
      viewportHeight,
      wheelTargets
    );
    for (let i = 0; i < wheelTargets.length; i += 1) {
      if (landings[i].invariant) {
        expect(
          landings[i].zoomAfterSnap,
          `wheel target ${wheelTargets[i]}: invariant held but landed at ${landings[i].zoomAfterSnap}`
        ).toBe(wheelTargets[i]);
      }
    }
  });

  it('Stale-latch trap: opening at zoom 100 then wheeling to a lower zoom that still satisfies invariant must NOT bounce back', () => {
    const sequence = loadFixture(PERF_MEDIUM);
    const containerWidth = 1200;
    const viewportHeight = 100;
    const landings = simulateUserWheel(sequence, true, containerWidth, viewportHeight, [100, 50]);
    expect(landings[0].zoomAfterSnap).toBe(100);
    expect(
      landings[1].zoomAfterSnap,
      `stale-latch trap: wheel from 100 → 50 should land at 50, landed at ${landings[1].zoomAfterSnap}`
    ).toBe(50);
  });
});

describe('canvas fit-once floor — algorithmic invariants', () => {
  it('snap-up effect strictly closes the gap on each iteration during convergence', () => {
    const sequence = loadFixture(PUC19);
    const trajectory = simulateRenderLoop(sequence, 1, 1200, 600, true, 20);
    let bestGap = Infinity;
    for (const frame of trajectory) {
      const gap = Math.max(0, 600 - frame.realContentHeight);
      bestGap = Math.min(bestGap, gap);
    }
    expect(bestGap).toBe(0);
  });

  it('floor never exceeds MAX_ZOOM and never goes below MIN_ZOOM', () => {
    const sequence = loadFixture(PUC19);
    const trajectory = simulateRenderLoop(sequence, 1, 1200, 600, true, 20);
    for (const frame of trajectory) {
      expect(frame.floor).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(frame.floor).toBeLessThanOrEqual(MAX_ZOOM);
    }
  });
});
