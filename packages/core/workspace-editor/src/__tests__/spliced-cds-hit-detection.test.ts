import { describe, it, expect, vi } from 'vitest';

vi.mock('../translation/codon-calculator', () => ({
  getAlignmentCodonsForCDS: vi.fn(),
  computeAllAlignmentCodons: vi.fn(),
}));

import {
  findSplicedCodonAtPosition,
  findIntronAtPosition,
  detectCDSLabelHit,
  calculateLineTrackBounds,
  type HitDetectionConfig,
} from '../hit-detection';
import type { Layout2DRow, ClassifiedCDS } from '../types';

const FWD_SEGMENTS = [
  { start: 1, end: 93 },
  { start: 244, end: 336 },
  { start: 488, end: 576 },
  { start: 699, end: 816 },
];

const ORIGIN_SEGMENTS = [
  { start: 451, end: 558 },
  { start: 101, end: 250 },
];

describe('findSplicedCodonAtPosition', () => {
  describe('forward CDS with 4 exons', () => {
    it('returns correct codon for position at start of exon 1', () => {
      const result = findSplicedCodonAtPosition(0, FWD_SEGMENTS);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(2);
    });

    it('returns correct codon for position in middle of exon 1', () => {
      const result = findSplicedCodonAtPosition(30, FWD_SEGMENTS);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(30);
      expect(result!.end).toBe(32);
    });

    it('returns correct codon for last codon of exon 1', () => {
      const result = findSplicedCodonAtPosition(91, FWD_SEGMENTS);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(90);
      expect(result!.end).toBe(92);
    });

    it('returns null for position in intron 1', () => {
      const result = findSplicedCodonAtPosition(100, FWD_SEGMENTS);
      expect(result).toBeNull();
    });

    it('returns null for position at intron start', () => {
      const result = findSplicedCodonAtPosition(93, FWD_SEGMENTS);
      expect(result).toBeNull();
    });

    it('returns null for position at intron end', () => {
      const result = findSplicedCodonAtPosition(242, FWD_SEGMENTS);
      expect(result).toBeNull();
    });

    it('returns correct codon for first position of exon 2', () => {
      const result = findSplicedCodonAtPosition(243, FWD_SEGMENTS);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(243);
      expect(result!.end).toBe(245);
    });

    it('returns correct codon for position in exon 3', () => {
      const result = findSplicedCodonAtPosition(490, FWD_SEGMENTS);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(490);
      expect(result!.end).toBe(492);
    });

    it('codon boundaries do NOT span introns', () => {
      const lastCodonE1 = findSplicedCodonAtPosition(92, FWD_SEGMENTS);
      expect(lastCodonE1).not.toBeNull();
      expect(lastCodonE1!.start).toBeGreaterThanOrEqual(0);
      expect(lastCodonE1!.end).toBeLessThanOrEqual(92);

      const firstCodonE2 = findSplicedCodonAtPosition(243, FWD_SEGMENTS);
      expect(firstCodonE2).not.toBeNull();
      expect(firstCodonE2!.start).toBeGreaterThanOrEqual(243);
      expect(firstCodonE2!.end).toBeLessThanOrEqual(335);
    });
  });

  describe('origin-spanning CDS', () => {
    it('returns correct codon in exon 1 (high positions)', () => {
      const result = findSplicedCodonAtPosition(453, ORIGIN_SEGMENTS);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(453);
      expect(result!.end).toBe(455);
    });

    it('returns correct codon in exon 2 (low positions, after origin)', () => {
      const result = findSplicedCodonAtPosition(150, ORIGIN_SEGMENTS);
      expect(result).not.toBeNull();
      expect(result!.start).toBeGreaterThanOrEqual(100);
      expect(result!.end).toBeLessThanOrEqual(249);
    });

    it('returns null for position in origin-spanning intron (post-origin)', () => {
      const result = findSplicedCodonAtPosition(0, ORIGIN_SEGMENTS);
      expect(result).toBeNull();
    });

    it('returns null for position in origin-spanning intron (pre-origin)', () => {
      const result = findSplicedCodonAtPosition(570, ORIGIN_SEGMENTS);
      expect(result).toBeNull();
    });
  });
});

describe('findIntronAtPosition', () => {
  it('returns intron range for position in first intron', () => {
    const result = findIntronAtPosition(100, FWD_SEGMENTS);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(93);
    expect(result!.end).toBe(242);
  });

  it('returns intron range for position in second intron', () => {
    const result = findIntronAtPosition(400, FWD_SEGMENTS);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(336);
    expect(result!.end).toBe(486);
  });

  it('returns null for position in an exon', () => {
    expect(findIntronAtPosition(50, FWD_SEGMENTS)).toBeNull();
  });

  it('returns null for position in exon 2', () => {
    expect(findIntronAtPosition(300, FWD_SEGMENTS)).toBeNull();
  });

  it('does not turn adjacent joined segments into an origin-spanning intron', () => {
    const adjacentSegments = [
      { start: 1284, end: 1352 },
      { start: 1353, end: 2144 },
    ];

    expect(findIntronAtPosition(299, adjacentSegments)).toBeNull();
    expect(findIntronAtPosition(2200, adjacentSegments)).toBeNull();
  });

  it('returns correct intron at exact intron start', () => {
    const result = findIntronAtPosition(93, FWD_SEGMENTS);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(93);
  });

  it('returns correct intron at exact intron end', () => {
    const result = findIntronAtPosition(242, FWD_SEGMENTS);
    expect(result).not.toBeNull();
    expect(result!.end).toBe(242);
  });

  describe('origin-spanning intron', () => {
    it('returns intron for position in pre-origin part', () => {
      const result = findIntronAtPosition(570, ORIGIN_SEGMENTS);
      expect(result).not.toBeNull();
    });

    it('returns intron for position in post-origin part', () => {
      const result = findIntronAtPosition(50, ORIGIN_SEGMENTS);
      expect(result).not.toBeNull();
    });

    it('returns null for position in exon 1', () => {
      expect(findIntronAtPosition(500, ORIGIN_SEGMENTS)).toBeNull();
    });

    it('returns null for position in exon 2', () => {
      expect(findIntronAtPosition(150, ORIGIN_SEGMENTS)).toBeNull();
    });
  });
});

const DEFAULT_CONFIG: HitDetectionConfig = {
  showAnnotations: true,
  showTranslation: true,
  showPrimers: false,
  marginLeft: 18,
  charWidth: 12,
  rowHeight: 20,
};

function createSplicedCDS(
  start: number,
  end: number,
  segments: Array<{ start: number; end: number }>,
  translationLane = 0
): ClassifiedCDS {
  return {
    name: 'SplicedGene',
    type: 'CDS',
    start,
    end,
    direction: 1,
    cdsType: 'full',
    translationLane,
    segments,
    qualifiers: { _locationString: ['join(mock)'] },
  };
}

function createLine(overrides: Partial<Layout2DRow> = {}): Layout2DRow {
  return {
    lineIndex: 0,
    startPos: 0,
    endPos: 100,
    sequence: 'A'.repeat(100),
    complementSequence: 'T'.repeat(100),
    y: 0,
    annotations: [],
    annotationLaneCount: 0,
    translationLaneCount: 0,
    ...overrides,
  };
}

describe('detectCDSLabelHit — label strip always returns full CDS', () => {
  const segments = [
    { start: 1, end: 30 },
    { start: 50, end: 80 },
  ];
  const splicedCDS = createSplicedCDS(1, 80, segments);

  const line = createLine({
    startPos: 0,
    endPos: 100,
    sequence: 'A'.repeat(100),
    classifiedCDSs: [splicedCDS],
    translationLaneCount: 1,
  });

  const bounds = calculateLineTrackBounds(line, DEFAULT_CONFIG, true, false, false);
  const labelStripY = line.y + bounds.translationY + 2;

  it('clicking thin line over exon 1 returns FULL CDS', () => {
    const mouseX = DEFAULT_CONFIG.marginLeft + 15 * DEFAULT_CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelStripY, line, bounds, DEFAULT_CONFIG, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(79);
  });

  it('clicking thin line over exon 2 returns FULL CDS', () => {
    const mouseX = DEFAULT_CONFIG.marginLeft + 60 * DEFAULT_CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelStripY, line, bounds, DEFAULT_CONFIG, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(79);
  });

  it('clicking thin line over intron returns FULL CDS', () => {
    const mouseX = DEFAULT_CONFIG.marginLeft + 40 * DEFAULT_CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelStripY, line, bounds, DEFAULT_CONFIG, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(79);
  });

  it('clicking outside CDS returns null', () => {
    const mouseX = DEFAULT_CONFIG.marginLeft + 90 * DEFAULT_CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelStripY, line, bounds, DEFAULT_CONFIG, 100);
    expect(result).toBeNull();
  });
});

describe('detectCDSLabelHit — origin-spanning CDS returns full CDS', () => {
  const originSegments = [
    { start: 451, end: 558 },
    { start: 101, end: 250 },
  ];
  const originCDS = createSplicedCDS(451, 250, originSegments);

  const exon1Line = createLine({
    startPos: 440,
    endPos: 520,
    sequence: 'A'.repeat(80),
    classifiedCDSs: [originCDS],
    translationLaneCount: 1,
  });
  const exon1Bounds = calculateLineTrackBounds(exon1Line, DEFAULT_CONFIG, true, false, false);

  it('clicking label strip over exon 1 returns FULL CDS range', () => {
    const charIdx = 470 - 440;
    const mouseX = DEFAULT_CONFIG.marginLeft + charIdx * DEFAULT_CONFIG.charWidth;
    const labelY = exon1Line.y + exon1Bounds.translationY + 2;
    const result = detectCDSLabelHit(mouseX, labelY, exon1Line, exon1Bounds, DEFAULT_CONFIG, 603);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(450);
    expect(result!.end).toBe(249);
  });
});

describe('detectCDSLabelHit — exon pill click returns exon range', () => {
  const segments = [
    { start: 1, end: 93 },
    { start: 244, end: 336 },
    { start: 488, end: 576 },
  ];
  const cds = createSplicedCDS(1, 576, segments);

  cds._exonPillBounds = [
    { x: 50, w: 30, rangeStart: 0, rangeEnd: 92 },
    { x: 90, w: 30, rangeStart: 243, rangeEnd: 335 },
    { x: 500, w: 30, rangeStart: 487, rangeEnd: 575 },
  ];

  const line = createLine({
    startPos: 0,
    endPos: 100,
    sequence: 'A'.repeat(100),
    classifiedCDSs: [cds],
    translationLaneCount: 1,
  });

  const bounds = calculateLineTrackBounds(line, DEFAULT_CONFIG, true, false, false);
  const labelStripY = line.y + bounds.translationY + 2;

  it('clicking on E1 pill returns exon 1 range', () => {
    const result = detectCDSLabelHit(60, labelStripY, line, bounds, DEFAULT_CONFIG, 600);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(92);
  });

  it('clicking on E2 pill returns exon 2 range', () => {
    const result = detectCDSLabelHit(100, labelStripY, line, bounds, DEFAULT_CONFIG, 600);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(243);
    expect(result!.end).toBe(335);
  });

  it('clicking on E3 floating pill returns exon 3 range', () => {
    const result = detectCDSLabelHit(510, labelStripY, line, bounds, DEFAULT_CONFIG, 600);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(487);
    expect(result!.end).toBe(575);
  });

  it('clicking between pills (on thin line) returns full CDS range', () => {
    const mouseX = DEFAULT_CONFIG.marginLeft + 15 * DEFAULT_CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelStripY, line, bounds, DEFAULT_CONFIG, 600);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(575);
  });

  it('clicking at pill left edge returns exon range', () => {
    const result = detectCDSLabelHit(50, labelStripY, line, bounds, DEFAULT_CONFIG, 600);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(92);
  });

  it('clicking at pill right edge returns exon range', () => {
    const result = detectCDSLabelHit(80, labelStripY, line, bounds, DEFAULT_CONFIG, 600);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(92);
  });

  it('clicking 1px past pill right edge falls through to full CDS', () => {
    const result = detectCDSLabelHit(81, labelStripY, line, bounds, DEFAULT_CONFIG, 600);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(575);
  });
});

describe('detectCDSLabelHit — CDS without pill bounds returns full CDS', () => {
  const segments = [
    { start: 1, end: 50 },
    { start: 80, end: 120 },
  ];
  const cds = createSplicedCDS(1, 120, segments);

  const line = createLine({
    startPos: 0,
    endPos: 150,
    sequence: 'A'.repeat(150),
    classifiedCDSs: [cds],
    translationLaneCount: 1,
  });

  const bounds = calculateLineTrackBounds(line, DEFAULT_CONFIG, true, false, false);
  const labelStripY = line.y + bounds.translationY + 2;

  it('clicking anywhere in label strip returns full CDS range', () => {
    const mouseX = DEFAULT_CONFIG.marginLeft + 25 * DEFAULT_CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelStripY, line, bounds, DEFAULT_CONFIG, 150);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(119);
  });
});
