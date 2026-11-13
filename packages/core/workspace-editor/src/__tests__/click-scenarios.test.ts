import { TRANSLATION_LABEL_HEIGHT, TRANSLATION_AA_HEIGHT_RATIO } from '../layout-constants';

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

const CONFIG: HitDetectionConfig = {
  showAnnotations: true,
  showTranslation: true,
  showPrimers: false,
  marginLeft: 18,
  charWidth: 12,
  rowHeight: 20,
};

function makeCDS(
  overrides: Partial<ClassifiedCDS> & { start: number; end: number }
): ClassifiedCDS {
  return {
    name: 'TestCDS',
    type: 'CDS',
    direction: 1,
    cdsType: 'full',
    translationLane: 0,
    ...overrides,
  };
}

function makeLine(overrides: Partial<Layout2DRow> = {}): Layout2DRow {
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

function getLabelStripY(line: Layout2DRow, lane = 0): number {
  const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
  const laneHeight = TRANSLATION_LABEL_HEIGHT + CONFIG.rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
  return line.y + bounds.translationY + lane * laneHeight + 7;
}

describe('Label strip click targets', () => {
  const segments = [
    { start: 1, end: 50 },
    { start: 80, end: 130 },
    { start: 200, end: 260 },
  ];

  describe('no pill bounds (pre-render state) — always full CDS', () => {
    const cds = makeCDS({ start: 1, end: 260, segments, name: 'GeneX' });
    const line = makeLine({
      startPos: 0,
      endPos: 300,
      sequence: 'A'.repeat(300),
      classifiedCDSs: [cds],
      translationLaneCount: 1,
    });
    const labelY = getLabelStripY(line);

    it('click over exon 1 region returns full CDS', () => {
      const mouseX = CONFIG.marginLeft + 25 * CONFIG.charWidth;
      const result = detectCDSLabelHit(
        mouseX,
        labelY,
        line,
        calculateLineTrackBounds(line, CONFIG, true, false, false),
        CONFIG,
        300
      );
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(259);
    });

    it('click over intron region returns full CDS', () => {
      const mouseX = CONFIG.marginLeft + 60 * CONFIG.charWidth;
      const result = detectCDSLabelHit(
        mouseX,
        labelY,
        line,
        calculateLineTrackBounds(line, CONFIG, true, false, false),
        CONFIG,
        300
      );
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(259);
    });
  });

  describe('with pill bounds — exon pills return exon range', () => {
    const cds = makeCDS({
      start: 1,
      end: 260,
      segments,
      name: 'GeneX',
      qualifiers: { _locationString: ['join(1..50,80..130,200..260)'] },
      _exonPillBounds: [
        { x: 40, w: 25, rangeStart: 0, rangeEnd: 49 },
        { x: 72, w: 25, rangeStart: 79, rangeEnd: 129 },
        { x: CONFIG.marginLeft + 200 * CONFIG.charWidth, w: 30, rangeStart: 199, rangeEnd: 259 },
      ],
    });
    const line = makeLine({
      startPos: 0,
      endPos: 300,
      sequence: 'A'.repeat(300),
      classifiedCDSs: [cds],
      translationLaneCount: 1,
    });
    const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
    const labelY = getLabelStripY(line);

    it('click on E1 pill returns exon 1 range', () => {
      const result = detectCDSLabelHit(50, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(49);
    });

    it('click on E2 pill returns exon 2 range', () => {
      const result = detectCDSLabelHit(80, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(79);
      expect(result!.end).toBe(129);
    });

    it('click on E3 floating pill returns exon 3 range', () => {
      const px = CONFIG.marginLeft + 200 * CONFIG.charWidth + 10;
      const result = detectCDSLabelHit(px, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(199);
      expect(result!.end).toBe(259);
    });

    it('click on thin line between pills returns full CDS', () => {
      const mouseX = CONFIG.marginLeft + 60 * CONFIG.charWidth;
      const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(259);
    });

    it('click on pill left edge is a hit', () => {
      const result = detectCDSLabelHit(40, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(49);
    });

    it('click on pill right edge is a hit', () => {
      const result = detectCDSLabelHit(65, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(49);
    });

    it('click 1px past pill right edge falls through to CDS', () => {
      const result = detectCDSLabelHit(66, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(0);
      expect(result!.end).toBe(259);
    });

    it('click outside CDS horizontal range returns null', () => {
      const mouseX = CONFIG.marginLeft + 280 * CONFIG.charWidth;
      const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 300);
      expect(result).toBeNull();
    });
  });

  describe('non-spliced CDS (no segments) — full CDS always', () => {
    const cds = makeCDS({ start: 10, end: 200, name: 'SimpleCDS' });
    const line = makeLine({
      startPos: 0,
      endPos: 300,
      sequence: 'A'.repeat(300),
      classifiedCDSs: [cds],
      translationLaneCount: 1,
    });
    const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
    const labelY = getLabelStripY(line);

    it('click returns full CDS range', () => {
      const mouseX = CONFIG.marginLeft + 50 * CONFIG.charWidth;
      const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 300);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(9);
      expect(result!.end).toBe(199);
    });
  });
});

describe('Multiple CDSs on same line', () => {
  const cds1 = makeCDS({
    start: 1,
    end: 80,
    name: 'CDS1',
    translationLane: 0,
    segments: [
      { start: 1, end: 30 },
      { start: 50, end: 80 },
    ],
    qualifiers: { _locationString: ['join(1..30,50..80)'] },
    _exonPillBounds: [
      { x: 40, w: 20, rangeStart: 0, rangeEnd: 29 },
      { x: 65, w: 20, rangeStart: 49, rangeEnd: 79 },
    ],
  });

  const cds2 = makeCDS({
    start: 10,
    end: 90,
    name: 'CDS2',
    translationLane: 1,
  });

  const line = makeLine({
    startPos: 0,
    endPos: 100,
    sequence: 'A'.repeat(100),
    classifiedCDSs: [cds1, cds2],
    translationLaneCount: 2,
  });
  const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);

  it('click on CDS1 lane 0 pill returns exon range', () => {
    const labelY = getLabelStripY(line, 0);
    const result = detectCDSLabelHit(50, labelY, line, bounds, CONFIG, 100);
    expect(result).not.toBeNull();
    expect(result!.annotation.name).toBe('CDS1');
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(29);
  });

  it('click on CDS2 lane 1 (no pills) returns full CDS2 range', () => {
    const labelY = getLabelStripY(line, 1);
    const mouseX = CONFIG.marginLeft + 50 * CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 100);
    expect(result).not.toBeNull();
    expect(result!.annotation.name).toBe('CDS2');
    expect(result!.start).toBe(9);
    expect(result!.end).toBe(89);
  });
});

describe('Origin-spanning CDS click scenarios', () => {
  const originSegments = [
    { start: 451, end: 558 },
    { start: 101, end: 250 },
  ];

  describe('exon pill clicks on origin-spanning CDS', () => {
    const cds = makeCDS({
      start: 451,
      end: 250,
      segments: originSegments,
      name: 'OriginCDS',
      qualifiers: { _locationString: ['join(451..558,101..250)'] },
      _exonPillBounds: [
        { x: 50, w: 25, rangeStart: 450, rangeEnd: 557 },
        { x: 80, w: 25, rangeStart: 100, rangeEnd: 249 },
      ],
    });

    const line = makeLine({
      startPos: 440,
      endPos: 520,
      sequence: 'A'.repeat(80),
      classifiedCDSs: [cds],
      translationLaneCount: 1,
    });
    const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
    const labelY = getLabelStripY(line);

    it('click on E1 pill returns exon 1 range', () => {
      const result = detectCDSLabelHit(60, labelY, line, bounds, CONFIG, 603);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(450);
      expect(result!.end).toBe(557);
    });

    it('click on E2 pill returns exon 2 range', () => {
      const result = detectCDSLabelHit(90, labelY, line, bounds, CONFIG, 603);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(100);
      expect(result!.end).toBe(249);
    });

    it('click on thin line returns full origin-spanning CDS range', () => {
      const charIdx = 480 - 440;
      const mouseX = CONFIG.marginLeft + charIdx * CONFIG.charWidth;
      const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 603);
      expect(result).not.toBeNull();
      expect(result!.start).toBe(450);
      expect(result!.end).toBe(249);
    });
  });
});

describe('findSplicedCodonAtPosition — edge cases', () => {
  const segments = [
    { start: 1, end: 9 },
    { start: 20, end: 28 },
  ];

  it('first base of first exon → codon [0,2]', () => {
    const r = findSplicedCodonAtPosition(0, segments);
    expect(r).toEqual({ start: 0, end: 2 });
  });

  it('last base of first exon → codon [6,8]', () => {
    const r = findSplicedCodonAtPosition(8, segments);
    expect(r).toEqual({ start: 6, end: 8 });
  });

  it('first base of second exon → codon [19,21]', () => {
    const r = findSplicedCodonAtPosition(19, segments);
    expect(r).toEqual({ start: 19, end: 21 });
  });

  it('last base of second exon → codon [25,27]', () => {
    const r = findSplicedCodonAtPosition(27, segments);
    expect(r).toEqual({ start: 25, end: 27 });
  });

  it('position before CDS start returns null', () => {
    expect(findSplicedCodonAtPosition(28, segments)).toBeNull();
  });

  it('position in intron (pos 10) returns null', () => {
    expect(findSplicedCodonAtPosition(10, segments)).toBeNull();
  });

  it('position at intron boundary start (pos 9) returns null', () => {
    expect(findSplicedCodonAtPosition(9, segments)).toBeNull();
  });

  it('position at intron boundary end (pos 18) returns null', () => {
    expect(findSplicedCodonAtPosition(18, segments)).toBeNull();
  });

  describe('phase 1 intron (intron splits codon after 1st base)', () => {
    const p1Segments = [
      { start: 1, end: 10 },
      { start: 30, end: 38 },
    ];

    it('last codon of exon 1 is partial (1 base) at pos 9', () => {
      const r = findSplicedCodonAtPosition(9, p1Segments);
      expect(r).not.toBeNull();
      expect(r!.start).toBe(9);
      expect(r!.end).toBe(30);
    });

    it('first codon of exon 2 continues the split codon', () => {
      const r = findSplicedCodonAtPosition(29, p1Segments);
      expect(r).not.toBeNull();
      expect(r!.start).toBe(9);
      expect(r!.end).toBe(30);
    });
  });
});

describe('findIntronAtPosition — edge cases', () => {
  const segments = [
    { start: 1, end: 50 },
    { start: 80, end: 130 },
    { start: 200, end: 260 },
  ];

  it('returns null for position before first exon', () => {
    expect(findIntronAtPosition(0, [{ start: 10, end: 50 }])).toBeNull();
  });

  it('intron 1: first intronic base', () => {
    const r = findIntronAtPosition(50, segments);
    expect(r).not.toBeNull();
    expect(r!.start).toBe(50);
    expect(r!.end).toBe(78);
  });

  it('intron 1: last intronic base', () => {
    const r = findIntronAtPosition(78, segments);
    expect(r).not.toBeNull();
    expect(r!.start).toBe(50);
    expect(r!.end).toBe(78);
  });

  it('intron 2: middle position', () => {
    const r = findIntronAtPosition(150, segments);
    expect(r).not.toBeNull();
    expect(r!.start).toBe(130);
    expect(r!.end).toBe(198);
  });

  it('exon boundary: last base of exon 1', () => {
    expect(findIntronAtPosition(49, segments)).toBeNull();
  });

  it('exon boundary: first base of exon 2', () => {
    expect(findIntronAtPosition(79, segments)).toBeNull();
  });

  it('returns null for single-segment CDS (no introns)', () => {
    expect(findIntronAtPosition(25, [{ start: 1, end: 100 }])).toBeNull();
  });

  describe('origin-spanning intron', () => {
    const oSegments = [
      { start: 451, end: 558 },
      { start: 101, end: 250 },
    ];

    it('position in post-exon1 region (559-602) is in intron', () => {
      const r = findIntronAtPosition(560, oSegments);
      expect(r).not.toBeNull();
      expect(r!.start).toBe(558);
      expect(r!.end).toBe(99);
    });

    it('position in pre-exon2 region (0-99) is in intron', () => {
      const r = findIntronAtPosition(50, oSegments);
      expect(r).not.toBeNull();
    });

    it('position in exon 1 is not intron', () => {
      expect(findIntronAtPosition(500, oSegments)).toBeNull();
    });

    it('position in exon 2 is not intron', () => {
      expect(findIntronAtPosition(150, oSegments)).toBeNull();
    });
  });
});

describe('detectCDSLabelHit — Y band precision', () => {
  const cds = makeCDS({ start: 1, end: 100, translationLane: 0 });
  const line = makeLine({
    classifiedCDSs: [cds],
    translationLaneCount: 1,
  });
  const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
  const mouseX = CONFIG.marginLeft + 50 * CONFIG.charWidth;

  it('click above label strip returns null', () => {
    const aboveLabelY = line.y + bounds.translationY - 1;
    const result = detectCDSLabelHit(mouseX, aboveLabelY, line, bounds, CONFIG, 100);
    expect(result).toBeNull();
  });

  it('click at label strip top edge returns CDS', () => {
    const topEdge = line.y + bounds.translationY;
    const result = detectCDSLabelHit(mouseX, topEdge, line, bounds, CONFIG, 100);
    expect(result).not.toBeNull();
  });

  it('click below label strip (in codon area) returns null', () => {
    const belowLabel = line.y + bounds.translationY + TRANSLATION_LABEL_HEIGHT + 1;
    const result = detectCDSLabelHit(mouseX, belowLabel, line, bounds, CONFIG, 100);
    expect(result).toBeNull();
  });

  it('returns null when showTranslation is false', () => {
    const noTransConfig = { ...CONFIG, showTranslation: false };
    const labelY = getLabelStripY(line);
    const result = detectCDSLabelHit(mouseX, labelY, line, bounds, noTransConfig, 100);
    expect(result).toBeNull();
  });

  it('returns null when no CDSs on line', () => {
    const emptyLine = makeLine({ classifiedCDSs: [], translationLaneCount: 0 });
    const emptyBounds = calculateLineTrackBounds(emptyLine, CONFIG, true, false, false);
    const labelY = line.y + bounds.translationY + 2;
    const result = detectCDSLabelHit(mouseX, labelY, emptyLine, emptyBounds, CONFIG, 100);
    expect(result).toBeNull();
  });
});

describe('detectCDSLabelHit — X boundaries', () => {
  const cds = makeCDS({ start: 20, end: 80 });
  const line = makeLine({
    startPos: 0,
    endPos: 100,
    sequence: 'A'.repeat(100),
    classifiedCDSs: [cds],
    translationLaneCount: 1,
  });
  const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
  const labelY = getLabelStripY(line);

  it('click in margin (before marginLeft) returns null', () => {
    const result = detectCDSLabelHit(5, labelY, line, bounds, CONFIG, 100);
    expect(result).toBeNull();
  });

  it('click at position just before CDS start returns null', () => {
    const mouseX = CONFIG.marginLeft + 18 * CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 100);
    expect(result).toBeNull();
  });

  it('click at CDS start position returns hit', () => {
    const mouseX = CONFIG.marginLeft + 19 * CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(19);
    expect(result!.end).toBe(79);
  });

  it('click past CDS end returns null', () => {
    const mouseX = CONFIG.marginLeft + 81 * CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 100);
    expect(result).toBeNull();
  });

  it('click past line length returns null', () => {
    const mouseX = CONFIG.marginLeft + 120 * CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 100);
    expect(result).toBeNull();
  });
});

describe('hitStart/hitEnd propagation from detectCDSLabelHit', () => {
  it('exon pill hit provides exon-specific start/end', () => {
    const cds = makeCDS({
      start: 1,
      end: 200,
      _exonPillBounds: [{ x: 50, w: 30, rangeStart: 0, rangeEnd: 49 }],
    });
    const line = makeLine({
      classifiedCDSs: [cds],
      translationLaneCount: 1,
    });
    const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
    const labelY = getLabelStripY(line);

    const result = detectCDSLabelHit(60, labelY, line, bounds, CONFIG, 200);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(49);
    expect(result!.annotation.start).toBe(1);
    expect(result!.annotation.end).toBe(200);
  });

  it('thin line hit provides full CDS start/end', () => {
    const cds = makeCDS({
      start: 1,
      end: 200,
      _exonPillBounds: [{ x: 50, w: 30, rangeStart: 0, rangeEnd: 49 }],
    });
    const line = makeLine({
      startPos: 0,
      endPos: 200,
      sequence: 'A'.repeat(200),
      classifiedCDSs: [cds],
      translationLaneCount: 1,
    });
    const bounds = calculateLineTrackBounds(line, CONFIG, true, false, false);
    const labelY = getLabelStripY(line);

    const mouseX = CONFIG.marginLeft + 90 * CONFIG.charWidth;
    const result = detectCDSLabelHit(mouseX, labelY, line, bounds, CONFIG, 200);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(199);
  });
});
