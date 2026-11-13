// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawTranslation } from '../translation-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';
import {
  CDS_EXTENSION_DIRECTION_QUALIFIER,
  CDS_EXTENSION_ORIGINAL_QUALIFIER,
} from '../cds-extension-affordance';
import type { ClassifiedCDS } from '../types';
import type { CdsExtensionArrowBounds } from '../cds-extension-affordance';

const LENGTH = 120;

function molecule(...placements: Array<[number, string]>): string {
  const bases = 'C'.repeat(LENGTH).split('');
  for (const [at, triplet] of placements) {
    for (let i = 0; i < triplet.length; i++) bases[(at + i) % LENGTH] = triplet[i];
  }
  return bases.join('');
}

function context(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = 2400;
  canvas.height = 400;
  return canvas.getContext('2d') as CanvasRenderingContext2D;
}

type Subject = {
  sequence: string;
  start: number;
  end: number;
  direction: 1 | -1;
  original?: string;
  drafted?: Array<'five-prime' | 'three-prime'>;
};

function arrowsFor(subject: Subject): CdsExtensionArrowBounds[] {
  const cds = {
    type: 'CDS',
    name: 'subject',
    start: subject.start,
    end: subject.end,
    direction: subject.direction,
    cdsType: 'full',
    translationLane: 0,
    ...(subject.original
      ? {
          qualifiers: {
            [CDS_EXTENSION_ORIGINAL_QUALIFIER]: [subject.original],
            ...(subject.drafted ? { [CDS_EXTENSION_DIRECTION_QUALIFIER]: subject.drafted } : {}),
          },
        }
      : {}),
  } as ClassifiedCDS;

  const result = drawTranslation(
    context(),
    subject.sequence,
    [cds],
    0,
    LENGTH,
    0,
    0,
    DEFAULT_EDITOR_CONFIG,
    subject.sequence,
    [],
    [],
    0,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { isCircularSequence: true, emitArrows: true, contentRightX: 2400 }
  );
  return result.extensionArrows ?? [];
}

function arrow(
  subject: Subject,
  direction: 'five-prime' | 'three-prime'
): CdsExtensionArrowBounds | undefined {
  return arrowsFor(subject).find((candidate) => candidate.direction === direction);
}

const FORWARD = molecule([3, 'ATG'], [69, 'TAA']);

const REVERSE = molecule([60, 'CAT'], [6, 'TTA']);

const FORWARD_WRAPPED = molecule([106, 'ATG'], [19, 'TAA']);

const REVERSE_WRAPPED = molecule([19, 'CAT'], [106, 'TTA']);

const forward: Subject = { sequence: FORWARD, start: 10, end: 60, direction: 1 };
const reverse: Subject = { sequence: REVERSE, start: 10, end: 60, direction: -1 };
const forwardWrapped: Subject = { sequence: FORWARD_WRAPPED, start: 110, end: 19, direction: 1 };
const reverseWrapped: Subject = { sequence: REVERSE_WRAPPED, start: 110, end: 19, direction: -1 };

describe('the fixtures really are incomplete at both ends', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it.each([
    ['forward', forward],
    ['reverse', reverse],
    ['forward wrapped', forwardWrapped],
    ['reverse wrapped', reverseWrapped],
  ])('%s offers both ends', (_label, subject) => {
    const ends = arrowsFor(subject as Subject)
      .map((a) => a.direction)
      .sort();
    expect(ends).toEqual(['five-prime', 'three-prime']);
  });
});

describe('extend arrows point AWAY from the CDS', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it.each([
    ['forward 5-prime', forward, 'five-prime', false],
    ['forward 3-prime', forward, 'three-prime', true],
    ['reverse 5-prime', reverse, 'five-prime', true],
    ['reverse 3-prime', reverse, 'three-prime', false],
    ['forward wrapped 5-prime', forwardWrapped, 'five-prime', false],
    ['forward wrapped 3-prime', forwardWrapped, 'three-prime', true],
    ['reverse wrapped 5-prime', reverseWrapped, 'five-prime', true],
    ['reverse wrapped 3-prime', reverseWrapped, 'three-prime', false],
  ])('%s', (_label, subject, direction, pointsRight) => {
    const found = arrow(subject as Subject, direction as 'five-prime');
    expect(found?.kind).toBe('extend');
    expect(found?.pointsRight).toBe(pointsRight);
  });

  it('the two ends land on opposite sides of a forward CDS', () => {
    expect(arrow(forward, 'five-prime')!.x).toBeLessThan(arrow(forward, 'three-prime')!.x);
  });

  it('and on opposite sides of a reverse CDS, the same way round on screen', () => {
    expect(arrow(reverse, 'three-prime')!.x).toBeLessThan(arrow(reverse, 'five-prime')!.x);
  });
});

describe('undo arrows point back INTO the CDS, outside the extended end', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  const forwardGrew5: Subject = {
    ...forward,
    start: 4,
    original: '10..60',
    drafted: ['five-prime'],
  };
  const forwardGrew3: Subject = {
    ...forward,
    end: 72,
    original: '10..60',
    drafted: ['three-prime'],
  };
  const reverseGrew5: Subject = {
    ...reverse,
    end: 63,
    original: '10..60',
    drafted: ['five-prime'],
  };
  const reverseGrew3: Subject = {
    ...reverse,
    start: 7,
    original: '10..60',
    drafted: ['three-prime'],
  };

  it.each([
    ['forward 5-prime undo', forwardGrew5, 'five-prime', true],
    ['forward 3-prime undo', forwardGrew3, 'three-prime', false],
    ['reverse 5-prime undo', reverseGrew5, 'five-prime', false],
    ['reverse 3-prime undo', reverseGrew3, 'three-prime', true],
  ])('%s', (_label, subject, direction, pointsRight) => {
    const found = arrow(subject as Subject, direction as 'five-prime');
    expect(found?.kind).toBe('undo');
    expect(found?.pointsRight).toBe(pointsRight);
  });

  it.each([
    ['forward 5-prime', forwardGrew5, forward, 'five-prime'],
    ['forward 3-prime', forwardGrew3, forward, 'three-prime'],
    ['reverse 5-prime', reverseGrew5, reverse, 'five-prime'],
    ['reverse 3-prime', reverseGrew3, reverse, 'three-prime'],
  ])(
    '%s undo points the opposite way to the extend arrow it replaced',
    (_label, grown, plain, direction) => {
      const grownArrow = arrow(grown as Subject, direction as 'five-prime')!;
      const plainArrow = arrow(plain as Subject, direction as 'five-prime')!;
      expect(grownArrow.pointsRight).toBe(!plainArrow.pointsRight);
    }
  );

  it('a 5-prime undo sits further LEFT than the extend arrow it replaced', () => {
    expect(arrow(forwardGrew5, 'five-prime')!.x).toBeLessThan(arrow(forward, 'five-prime')!.x);
  });

  it('a 3-prime undo sits further RIGHT than the extend arrow it replaced', () => {
    expect(arrow(forwardGrew3, 'three-prime')!.x).toBeGreaterThan(arrow(forward, 'three-prime')!.x);
  });

  it('the other, un-drafted end still shows its own extend arrow', () => {
    const other = arrow(forwardGrew5, 'three-prime');
    expect(other?.kind).toBe('extend');
    expect(other?.pointsRight).toBe(true);
  });

  it('never emits two arrows for one end', () => {
    for (const subject of [forwardGrew5, forwardGrew3, reverseGrew5, reverseGrew3]) {
      const keys = arrowsFor(subject).map((a) => a.direction);
      expect(new Set(keys).size, JSON.stringify(subject)).toBe(keys.length);
    }
  });
});

describe('a draft whose CDS runs through the origin behaves the same', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('forward wrapped, grown at the 3-prime end: undo points back inward', () => {
    const grown: Subject = {
      ...forwardWrapped,
      end: 22,
      original: '110..19',
      drafted: ['three-prime'],
    };
    const found = arrow(grown, 'three-prime');
    expect(found?.kind).toBe('undo');
    expect(found?.pointsRight).toBe(false);
  });

  it('forward wrapped, grown at the 5-prime end: undo points back inward', () => {
    const grown: Subject = {
      ...forwardWrapped,
      start: 107,
      original: '110..19',
      drafted: ['five-prime'],
    };
    const found = arrow(grown, 'five-prime');
    expect(found?.kind).toBe('undo');
    expect(found?.pointsRight).toBe(true);
  });

  it('reverse wrapped, grown at the 5-prime end: undo points back inward', () => {
    const grown: Subject = {
      ...reverseWrapped,
      end: 22,
      original: '110..19',
      drafted: ['five-prime'],
    };
    const found = arrow(grown, 'five-prime');
    expect(found?.kind).toBe('undo');
    expect(found?.pointsRight).toBe(false);
  });
});
