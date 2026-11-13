import { TRANSLATION_LABEL_HEIGHT } from '../layout-constants';

import { describe, it, expect, vi } from 'vitest';
import { TRANSLATION_LABEL_HEIGHT } from '../layout-constants';

vi.mock('../translation/codon-calculator', () => ({
  getAlignmentCodonsForCDS: vi.fn(),
  computeAllAlignmentCodons: vi.fn(),
}));

import {
  detectAnnotationHit,
  detectHandleHit,
  detectCodonHit,
  getPositionFromX,
  getCursorPositionFromX,
  findLineAtY,
  getHitTarget,
  calculateLineTrackBounds,
  hitTestLabels,
  detectCutSiteLabelHit,
  detectGGLabelHit,
  type HitDetectionConfig,
  type LineTrackBounds,
  type LabelBounds,
} from '../hit-detection';
import { getAlignmentCodonsForCDS } from '../translation/codon-calculator';
import type { Layout2DRow, ClassifiedCDS } from '../types';

type Annotation = {
  name: string;
  type: string;
  start: number;
  end: number;
  direction?: number;
  lane?: number;
};

const SEQ_LEN = 10000;

const DEFAULT_CONFIG: HitDetectionConfig = {
  showAnnotations: true,
  showTranslation: true,
  showPrimers: false,
  marginLeft: 18,
  charWidth: 12,
  rowHeight: 20,
};

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

function createAnnotation(
  start: number,
  end: number,
  lane: number = 0,
  type: string = 'gene'
): Annotation & { lane: number } {
  return {
    name: `Annotation_${start}_${end}`,
    type,
    start,
    end,
    lane,
    direction: 1,
  };
}

function createClassifiedCDS(
  start: number,
  end: number,
  translationLane: number = 0
): ClassifiedCDS {
  return {
    name: `CDS_${start}_${end}`,
    type: 'CDS',
    start,
    end,
    direction: 1,
    cdsType: 'full',
    translationLane,
  };
}

function createBounds(line: Layout2DRow, config: HitDetectionConfig): LineTrackBounds {
  return calculateLineTrackBounds(line, config, true, false, false);
}

describe('detectAnnotationHit', () => {
  describe('Normal annotations', () => {
    it('should detect click on annotation center', () => {
      const ann = createAnnotation(10, 50, 0);
      const line = createLine({
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 30 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('annotation');
      expect(result?.start).toBe(9);
      expect(result?.end).toBe(49);
    });

    it('should return null when clicking outside annotation X bounds', () => {
      const ann = createAnnotation(10, 50, 0);
      const line = createLine({
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 60 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).toBeNull();
    });

    it('should return null when clicking outside annotation Y bounds', () => {
      const ann = createAnnotation(10, 50, 0);
      const line = createLine({
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 30 * 12;
      const contentY = line.y + bounds.sequenceY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).toBeNull();
    });

    it('should detect correct annotation when multiple are present', () => {
      const ann1 = createAnnotation(10, 30, 0);
      const ann2 = createAnnotation(40, 60, 0);
      const line = createLine({
        annotations: [ann1, ann2],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 50 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.start).toBe(39);
      expect(result?.end).toBe(59);
    });

    it('should detect a normal annotation drawn on the pre-origin segment of an origin-spanning row', () => {
      const ann = createAnnotation(9950, 9980, 0);
      const line = createLine({
        startPos: 9900,
        endPos: 100,
        sequence: 'A'.repeat(200),
        preOriginLength: 100,
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = DEFAULT_CONFIG.marginLeft + 60 * DEFAULT_CONFIG.charWidth;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.annotation).toBe(ann);
      expect(result?.start).toBe(9949);
      expect(result?.end).toBe(9979);
    });

    it('should detect a normal annotation drawn on the post-origin segment of an origin-spanning row', () => {
      const ann = createAnnotation(20, 50, 0);
      const line = createLine({
        startPos: 9900,
        endPos: 100,
        sequence: 'A'.repeat(200),
        preOriginLength: 100,
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = DEFAULT_CONFIG.marginLeft + 120 * DEFAULT_CONFIG.charWidth;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.annotation).toBe(ann);
      expect(result?.start).toBe(19);
      expect(result?.end).toBe(49);
    });

    it('should detect annotation on correct lane', () => {
      const ann1 = createAnnotation(10, 50, 0);
      const ann2 = createAnnotation(20, 40, 1);
      const line = createLine({
        annotations: [ann1, ann2],
        annotationLaneCount: 2,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const laneHeight = 16 * 0.7 + 4;
      const contentY = line.y + bounds.annotationY + laneHeight + 5;
      const mouseX = 18 + 30 * 12;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.start).toBe(19);
    });
  });

  describe('Origin-spanning annotations on normal lines', () => {
    it('should detect click on pre-origin segment', () => {
      const ann = createAnnotation(9900, 200, 0);

      const line = createLine({
        startPos: 9800,
        endPos: 9900,
        sequence: 'A'.repeat(100),
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 50 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).toBeNull();
    });

    it('should detect click inside pre-origin segment of origin-spanning annotation', () => {
      const ann = createAnnotation(9800, 200, 0);

      const line = createLine({
        startPos: 9750,
        endPos: 9850,
        sequence: 'A'.repeat(100),
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 70 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.start).toBe(9799);
      expect(result?.end).toBe(199);
    });

    it('should detect click on post-origin segment', () => {
      const ann = createAnnotation(9800, 200, 0);

      const line = createLine({
        startPos: 50,
        endPos: 150,
        sequence: 'A'.repeat(100),
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 50 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.start).toBe(9799);
    });

    it('should NOT detect click outside origin-spanning annotation', () => {
      const ann = createAnnotation(9800, 200, 0);

      const line = createLine({
        startPos: 500,
        endPos: 600,
        sequence: 'A'.repeat(100),
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 50 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).toBeNull();
    });

    it('should NOT detect annotation when line is entirely in the gap', () => {
      const ann = createAnnotation(9900, 100, 0);

      const line = createLine({
        startPos: 5000,
        endPos: 5100,
        sequence: 'A'.repeat(100),
        annotations: [ann],
        annotationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 50 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).toBeNull();
    });
  });

  describe('Origin-spanning annotations on origin-spanning lines', () => {
    it('should detect annotation when both line and annotation span origin', () => {
      const ann = createAnnotation(9900, 200, 0);

      const line = createLine({
        startPos: 9950,
        endPos: 50,
        sequence: 'A'.repeat(100),
        annotations: [ann],
        annotationLaneCount: 1,
        preOriginLength: 50,
        originPosition: 50,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 20 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.start).toBe(9899);
    });

    it('should detect annotation in post-origin segment of origin-spanning line', () => {
      const ann = createAnnotation(9900, 200, 0);

      const line = createLine({
        startPos: 9950,
        endPos: 50,
        sequence: 'A'.repeat(100),
        annotations: [ann],
        annotationLaneCount: 1,
        preOriginLength: 50,
        originPosition: 50,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 80 * 12;
      const contentY = line.y + bounds.annotationY + 5;

      const result = detectAnnotationHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

      expect(result).not.toBeNull();
      expect(result?.start).toBe(9899);
    });
  });
});

describe('detectHandleHit', () => {
  it('should detect start handle', () => {
    const result = detectHandleHit(100, { start: 100, end: 500 });
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('start');
  });

  it('should detect end handle (at end + 1 for right edge)', () => {
    const result = detectHandleHit(501, { start: 100, end: 500 });
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('end');
  });

  it('should return null when not near any handle', () => {
    const result = detectHandleHit(300, { start: 100, end: 500 });
    expect(result).toBeNull();
  });

  it('should return null for point selection (start === end)', () => {
    const result = detectHandleHit(100, { start: 100, end: 100 });
    expect(result).toBeNull();
  });

  it('should respect tolerance parameter', () => {
    const result = detectHandleHit(102, { start: 100, end: 500 }, 2);
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('start');
  });

  it('should handle wrapping selections', () => {
    const result = detectHandleHit(9000, { start: 9000, end: 500, wraps: true });
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('start');
  });
});

describe('detectCodonHit', () => {
  it('should detect click on codon', () => {
    const cds = createAnnotation(10, 100, 0, 'CDS');
    const classifiedCds = createClassifiedCDS(10, 100, 0);
    const line = createLine({
      startPos: 0,
      endPos: 100,
      annotations: [cds],
      annotationLaneCount: 1,
      classifiedCDSs: [classifiedCds],
      translationLaneCount: 1,
    });
    const bounds = createBounds(line, DEFAULT_CONFIG);

    const mouseX = 18 + 20 * 12;
    const contentY = line.y + bounds.translationY + TRANSLATION_LABEL_HEIGHT + 2;

    const result = detectCodonHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('codon');
    expect(result?.start).toBe(18);
    expect(result?.end).toBe(20);
  });

  it('should return null when clicking outside translation area', () => {
    const cds = createAnnotation(10, 100, 0, 'CDS');
    const classifiedCds = createClassifiedCDS(10, 100, 0);
    const line = createLine({
      annotations: [cds],
      annotationLaneCount: 1,
      classifiedCDSs: [classifiedCds],
      translationLaneCount: 1,
    });
    const bounds = createBounds(line, DEFAULT_CONFIG);

    const mouseX = 18 + 20 * 12;
    const contentY = line.y + bounds.sequenceY + 5;

    const result = detectCodonHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).toBeNull();
  });

  describe('overlay click in alignment mode returns full CDS range', () => {
    const classifiedCds = {
      ...createClassifiedCDS(1, 60, 0),
      startCol: 0,
      endCol: 60,
    };

    const lineCodons = Array.from({ length: 10 }, (_, i) => ({
      columnStart: i * 3,
      columnEnd: i * 3 + 2,
      visibleColumnStart: i * 3,
      visibleColumnEnd: i * 3 + 2,
      renderLetter: true,
      isPartialAtStart: false,
      refAa: 'M',
      queryAa: 'M',
      status: 'match' as const,
      codonIndex: i,
    }));

    it('should return single codon for click on CDS lane', () => {
      vi.mocked(getAlignmentCodonsForCDS).mockReturnValue(lineCodons);

      const line = createLine({
        startPos: 0,
        endPos: 30,
        sequence: 'A'.repeat(30),
        classifiedCDSs: [classifiedCds],
        translationLaneCount: 1,
      });
      const bounds = createBounds(line, DEFAULT_CONFIG);

      const mouseX = 18 + 10 * 12;
      const contentY = line.y + bounds.translationY + TRANSLATION_LABEL_HEIGHT + 6;

      const result = detectCodonHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN, {
        alignedRef: 'A'.repeat(60),
        alignedQuery: 'A'.repeat(60),
      });

      expect(result).not.toBeNull();
      expect(result?.isOverlayClick).toBe(false);
      expect(result?.start).toBe(9);
      expect(result?.end).toBe(11);
    });
  });

  it('should return null when no CDS annotation', () => {
    const gene = createAnnotation(10, 100, 0, 'gene');
    const line = createLine({
      annotations: [gene],
      annotationLaneCount: 1,
      classifiedCDSs: [],
      translationLaneCount: 0,
    });
    const bounds = createBounds(line, DEFAULT_CONFIG);

    const mouseX = 18 + 20 * 12;
    const contentY = line.y + bounds.translationY + 5;

    const result = detectCodonHit(mouseX, contentY, line, bounds, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).toBeNull();
  });
});

describe('getPositionFromX', () => {
  it('should calculate position on normal line', () => {
    const line = createLine({ startPos: 1000, endPos: 1100 });
    const mouseX = 18 + 50 * 12;

    const result = getPositionFromX(mouseX, line, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).toBe(1050);
  });

  it('should handle clicks at line start', () => {
    const line = createLine({ startPos: 1000, endPos: 1100 });
    const mouseX = 18;

    const result = getPositionFromX(mouseX, line, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).toBe(1000);
  });

  it('should clamp to line bounds', () => {
    const line = createLine({
      startPos: 1000,
      endPos: 1100,
      sequence: 'A'.repeat(100),
    });
    const mouseX = 18 + 150 * 12;

    const result = getPositionFromX(mouseX, line, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).toBe(1099);
  });

  it('should return null for click in margin', () => {
    const line = createLine();
    const mouseX = 5;

    const result = getPositionFromX(mouseX, line, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).toBeNull();
  });

  it('should handle origin-spanning lines correctly', () => {
    const line = createLine({
      startPos: 9950,
      endPos: 50,
      sequence: 'A'.repeat(100),
      preOriginLength: 50,
    });

    const mouseX = 18 + 60 * 12;
    const result = getPositionFromX(mouseX, line, DEFAULT_CONFIG, SEQ_LEN);

    expect(result).toBe(10);
  });
});

describe('getCursorPositionFromX', () => {
  it('distinguishes a nucleotide hit from the boundary after its right half', () => {
    const line = createLine({ startPos: 1000, endPos: 1100 });
    const mouseX = DEFAULT_CONFIG.marginLeft + 50.75 * DEFAULT_CONFIG.charWidth;

    expect(getPositionFromX(mouseX, line, DEFAULT_CONFIG, SEQ_LEN)).toBe(1050);
    expect(getCursorPositionFromX(mouseX, line, DEFAULT_CONFIG)).toBe(1051);
  });

  it.each([
    [49.25, 9999],
    [49.75, 0],
    [60.75, 11],
    [100.75, 50],
  ])('maps column %s to boundary %s on an origin-spanning row', (column, boundary) => {
    const line = createLine({ startPos: 9950, endPos: 50, preOriginLength: 50 });
    const mouseX = DEFAULT_CONFIG.marginLeft + column * DEFAULT_CONFIG.charWidth;

    expect(getCursorPositionFromX(mouseX, line, DEFAULT_CONFIG)).toBe(boundary);
  });

  it('allows a cursor after the final nucleotide of a linear sequence', () => {
    const line = createLine({ startPos: SEQ_LEN - 100, endPos: SEQ_LEN });
    const mouseX = DEFAULT_CONFIG.marginLeft + 99.75 * DEFAULT_CONFIG.charWidth;

    expect(getCursorPositionFromX(mouseX, line, DEFAULT_CONFIG)).toBe(SEQ_LEN);
  });

  it('rejects cursor placement in the left margin', () => {
    expect(getCursorPositionFromX(5, createLine(), DEFAULT_CONFIG)).toBeNull();
  });
});

describe('findLineAtY', () => {
  const lines: Layout2DRow[] = [
    createLine({ lineIndex: 0, y: 0 }),
    createLine({ lineIndex: 1, y: 100 }),
    createLine({ lineIndex: 2, y: 200 }),
  ];

  it('should find correct line', () => {
    const result = findLineAtY(150, lines, 300);
    expect(result?.lineIndex).toBe(1);
  });

  it('should return first line for y = 0', () => {
    const result = findLineAtY(0, lines, 300);
    expect(result?.lineIndex).toBe(0);
  });

  it('should return last line for y near end', () => {
    const result = findLineAtY(250, lines, 300);
    expect(result?.lineIndex).toBe(2);
  });

  it('should return null for y past total height', () => {
    const result = findLineAtY(350, lines, 300);
    expect(result).toBeNull();
  });

  it('picks the actual painted row when density rows have no gaps', () => {
    const dense = [0, 1, 2].map((lineIndex) =>
      createLine({ lineIndex, y: lineIndex, naturalHeight: 1, heightScale: 1 })
    );
    expect(findLineAtY(0.5, dense, 3)?.lineIndex).toBe(0);
    expect(findLineAtY(1.5, dense, 3)?.lineIndex).toBe(1);
  });

  it('uses the current morphed row end when row gaps are changing', () => {
    const moving = [0, 1].map((lineIndex) =>
      createLine({
        lineIndex,
        y: lineIndex * 14,
        naturalHeight: 20,
        trackMorph: { natural: [0, 20], painted: [0, 10] },
      })
    );
    expect(findLineAtY(9, moving, 28)?.lineIndex).toBe(0);
    expect(findLineAtY(12, moving, 28)?.lineIndex).toBe(1);
    expect(findLineAtY(15, moving, 28)?.lineIndex).toBe(1);
  });
});

describe('getHitTarget', () => {
  it('should return empty for click in margin', () => {
    const line = createLine();
    const result = getHitTarget(5, 10, 0, [line], 100, DEFAULT_CONFIG, SEQ_LEN, null, true, []);

    expect(result.type).toBe('empty');
  });

  it('should return nucleotide for click on sequence', () => {
    const line = createLine();
    const bounds = createBounds(line, DEFAULT_CONFIG);

    const result = getHitTarget(
      18 + 50 * 12,
      bounds.sequenceY + 10,
      0,
      [line],
      100,
      DEFAULT_CONFIG,
      SEQ_LEN,
      null,
      true,
      []
    );

    expect(result.type).toBe('nucleotide');
    if (result.type === 'nucleotide') {
      expect(result.position).toBe(50);
    }
  });

  it('should prioritize handle over annotation', () => {
    const ann = createAnnotation(10, 100, 0);
    const line = createLine({
      annotations: [ann],
      annotationLaneCount: 1,
    });

    const currentSelection = { start: 9, end: 50 };

    const result = getHitTarget(
      18 + 9 * 12,
      5,
      0,
      [line],
      100,
      DEFAULT_CONFIG,
      SEQ_LEN,
      currentSelection,
      true,
      []
    );

    expect(result.type).toBe('handle');
  });

  it('should detect annotation when no selection handle nearby', () => {
    const ann = createAnnotation(10, 100, 0);
    const line = createLine({
      annotations: [ann],
      annotationLaneCount: 1,
    });
    const bounds = createBounds(line, DEFAULT_CONFIG);

    const result = getHitTarget(
      18 + 50 * 12,
      bounds.annotationY + 5,
      0,
      [line],
      100,
      DEFAULT_CONFIG,
      SEQ_LEN,
      null,
      true,
      []
    );

    expect(result.type).toBe('annotation');
  });
});

describe('hitTestLabels', () => {
  const createLabel = (
    bounds: LabelBounds,
    id: string
  ): { labelBounds: LabelBounds; id: string } => ({
    labelBounds: bounds,
    id,
  });

  describe('happy path', () => {
    it('should return label when click is inside bounds', () => {
      const labels = [createLabel({ x: 40, y: 20, width: 30, height: 20 }, 'label1')];
      const result = hitTestLabels(50, 30, labels);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('label1');
    });

    it('should return first matching label when multiple overlap', () => {
      const labels = [
        createLabel({ x: 40, y: 20, width: 30, height: 20 }, 'first'),
        createLabel({ x: 45, y: 25, width: 20, height: 15 }, 'second'),
      ];
      const result = hitTestLabels(50, 30, labels);
      expect(result?.id).toBe('first');
    });

    it('should return second label when click is only in second', () => {
      const labels = [
        createLabel({ x: 40, y: 20, width: 20, height: 20 }, 'first'),
        createLabel({ x: 50, y: 25, width: 20, height: 15 }, 'second'),
      ];
      const result = hitTestLabels(65, 32, labels);
      expect(result?.id).toBe('second');
    });
  });

  describe('boundary conditions', () => {
    const label = createLabel({ x: 40, y: 20, width: 30, height: 20 }, 'test');

    it('should return label when click is exactly on left edge', () => {
      const result = hitTestLabels(40, 30, [label]);
      expect(result).not.toBeNull();
    });

    it('should return label when click is exactly on top edge', () => {
      const result = hitTestLabels(50, 20, [label]);
      expect(result).not.toBeNull();
    });

    it('should return label when click is exactly on right edge (x + width)', () => {
      const result = hitTestLabels(70, 30, [label]);
      expect(result).not.toBeNull();
    });

    it('should return label when click is exactly on bottom edge (y + height)', () => {
      const result = hitTestLabels(50, 40, [label]);
      expect(result).not.toBeNull();
    });

    it('should return null when click is 1px beyond right edge', () => {
      const result = hitTestLabels(71, 30, [label]);
      expect(result).toBeNull();
    });

    it('should return null when click is 1px beyond bottom edge', () => {
      const result = hitTestLabels(50, 41, [label]);
      expect(result).toBeNull();
    });

    it('should return null when click is 1px before left edge', () => {
      const result = hitTestLabels(39, 30, [label]);
      expect(result).toBeNull();
    });

    it('should return null when click is 1px before top edge', () => {
      const result = hitTestLabels(50, 19, [label]);
      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should return null when labels array is empty', () => {
      const result = hitTestLabels(50, 30, []);
      expect(result).toBeNull();
    });

    it('should handle labels with zero width (point on left edge)', () => {
      const label = createLabel({ x: 40, y: 20, width: 0, height: 20 }, 'zero-width');
      const result = hitTestLabels(40, 30, [label]);
      expect(result).not.toBeNull();
    });

    it('should handle labels with zero height (point on top edge)', () => {
      const label = createLabel({ x: 40, y: 20, width: 30, height: 0 }, 'zero-height');
      const result = hitTestLabels(50, 20, [label]);
      expect(result).not.toBeNull();
    });

    it('should handle negative coordinates in bounds', () => {
      const label = createLabel({ x: -10, y: -10, width: 20, height: 20 }, 'negative');
      const result = hitTestLabels(-5, -5, [label]);
      expect(result).not.toBeNull();
    });

    it('should handle fractional coordinates', () => {
      const label = createLabel({ x: 40, y: 20, width: 30, height: 20 }, 'test');
      const result = hitTestLabels(50.5, 30.7, [label]);
      expect(result).not.toBeNull();
    });

    it('should handle very large coordinates', () => {
      const label = createLabel({ x: 9990, y: 9990, width: 20, height: 20 }, 'large');
      const result = hitTestLabels(10000, 10000, [label]);
      expect(result).not.toBeNull();
    });
  });
});

describe('detectCutSiteLabelHit', () => {
  const createRenderedSite = (
    bounds: LabelBounds,
    cutSite: { name: string; position: number }
  ) => ({
    labelBounds: bounds,
    cutSite,
  });

  it('should return cutSite when click is inside bounds', () => {
    const sites = [
      createRenderedSite(
        { x: 40, y: 20, width: 30, height: 20 },
        { name: 'EcoRI', position: 1234 }
      ),
    ];
    const result = detectCutSiteLabelHit(50, 30, sites);
    expect(result).toEqual({ name: 'EcoRI', position: 1234 });
  });

  it('should return first cutSite when multiple labels overlap', () => {
    const sites = [
      createRenderedSite({ x: 40, y: 20, width: 30, height: 20 }, { name: 'EcoRI', position: 100 }),
      createRenderedSite({ x: 45, y: 25, width: 20, height: 15 }, { name: 'BamHI', position: 200 }),
    ];
    const result = detectCutSiteLabelHit(50, 30, sites);
    expect(result?.name).toBe('EcoRI');
  });

  it('should return null when click is outside all bounds', () => {
    const sites = [
      createRenderedSite(
        { x: 40, y: 20, width: 30, height: 20 },
        { name: 'EcoRI', position: 1234 }
      ),
    ];
    const result = detectCutSiteLabelHit(100, 100, sites);
    expect(result).toBeNull();
  });

  it('should return null when sites array is empty', () => {
    const result = detectCutSiteLabelHit(50, 30, []);
    expect(result).toBeNull();
  });

  it('should return cutSite on boundary edges', () => {
    const sites = [
      createRenderedSite(
        { x: 40, y: 20, width: 30, height: 20 },
        { name: 'EcoRI', position: 1234 }
      ),
    ];
    expect(detectCutSiteLabelHit(70, 30, sites)).not.toBeNull();
    expect(detectCutSiteLabelHit(50, 40, sites)).not.toBeNull();
    expect(detectCutSiteLabelHit(71, 30, sites)).toBeNull();
  });
});

describe('detectGGLabelHit', () => {
  const createGGLabel = (bounds: LabelBounds, product: string) => ({
    labelBounds: bounds,
    product,
    overhang: 'AATG',
  });

  it('should return entire label object when hit', () => {
    const labels = [createGGLabel({ x: 40, y: 20, width: 30, height: 20 }, 'pGG-001')];
    const result = detectGGLabelHit(50, 30, labels);
    expect(result).not.toBeNull();
    expect(result?.product).toBe('pGG-001');
    expect(result?.overhang).toBe('AATG');
    expect(result?.labelBounds).toEqual({ x: 40, y: 20, width: 30, height: 20 });
  });

  it('should return first matching label when multiple overlap', () => {
    const labels = [
      createGGLabel({ x: 40, y: 20, width: 30, height: 20 }, 'pGG-001'),
      createGGLabel({ x: 45, y: 25, width: 20, height: 15 }, 'pGG-002'),
    ];
    const result = detectGGLabelHit(50, 30, labels);
    expect(result?.product).toBe('pGG-001');
  });

  it('should return null when no labels match', () => {
    const labels = [createGGLabel({ x: 40, y: 20, width: 30, height: 20 }, 'pGG-001')];
    const result = detectGGLabelHit(100, 100, labels);
    expect(result).toBeNull();
  });

  it('should return null when labels array is empty', () => {
    const result = detectGGLabelHit(50, 30, []);
    expect(result).toBeNull();
  });

  it('should return label on boundary edges', () => {
    const labels = [createGGLabel({ x: 40, y: 20, width: 30, height: 20 }, 'pGG-001')];
    expect(detectGGLabelHit(70, 30, labels)).not.toBeNull();
    expect(detectGGLabelHit(50, 40, labels)).not.toBeNull();
    expect(detectGGLabelHit(71, 30, labels)).toBeNull();
    expect(detectGGLabelHit(50, 41, labels)).toBeNull();
  });
});
