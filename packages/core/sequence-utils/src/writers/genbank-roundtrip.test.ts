import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull } from '../parsers/genbank';
import { serializeGenBank } from './genbank';
import type { AnnotatedSequence, Annotation } from '../types';

const TEST_FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');

const FIXTURE_PATHS: Record<string, string> = {
  'sfgfp-cds.gb': 'sequences/linear/sfgfp-cds.gb',
  'pUC19.gb': 'sequences/circular/pUC19.gb',
  'perf-medium-synthetic.gb': 'sequences/circular/perf-medium-synthetic.gb',
};

function loadFixture(name: string): { raw: string; parsed: AnnotatedSequence } {
  const relativePath = FIXTURE_PATHS[name];
  if (!relativePath) {
    throw new Error(
      `Unknown fixture "${name}". Add to FIXTURE_PATHS in genbank-roundtrip.test.ts.`
    );
  }
  const raw = readFileSync(join(TEST_FIXTURES_DIR, relativePath), 'utf-8');
  const parsed = parseGenBankFull(raw);
  return { raw, parsed };
}

function insertBases(seq: AnnotatedSequence, position: number, bases: string): AnnotatedSequence {
  const newSeq = seq.sequence.slice(0, position) + bases + seq.sequence.slice(position);
  const newAnnotations = seq.annotations.map((ann) => {
    const newStart = ann.start > position ? ann.start + bases.length : ann.start;
    const newEnd = ann.end >= position ? ann.end + bases.length : ann.end;
    return { ...ann, start: newStart, end: newEnd };
  });
  return { ...seq, sequence: newSeq, length: newSeq.length, annotations: newAnnotations };
}

function deleteBases(seq: AnnotatedSequence, start: number, end: number): AnnotatedSequence {
  const deleteLen = end - start;
  const newSeq = seq.sequence.slice(0, start) + seq.sequence.slice(end);
  const newAnnotations = seq.annotations
    .map((ann) => {
      if (ann.start >= start + 1 && ann.end <= end) return null;
      const newStart = ann.start > start ? Math.max(1, ann.start - deleteLen) : ann.start;
      const newEnd = ann.end > start ? Math.max(1, ann.end - deleteLen) : ann.end;
      return { ...ann, start: newStart, end: newEnd };
    })
    .filter((a): a is Annotation => a !== null);
  return { ...seq, sequence: newSeq, length: newSeq.length, annotations: newAnnotations };
}

function substituteBases(
  seq: AnnotatedSequence,
  position: number,
  newBases: string
): AnnotatedSequence {
  const newSeq =
    seq.sequence.slice(0, position) + newBases + seq.sequence.slice(position + newBases.length);
  return { ...seq, sequence: newSeq, length: newSeq.length };
}

describe('round-trip with real fixtures (no edits)', () => {
  const fixtures = ['sfgfp-cds.gb', 'pUC19.gb', 'perf-medium-synthetic.gb'];

  it('reads the public pUC19 record with its one whole-plasmid source feature', () => {
    const { parsed } = loadFixture('pUC19.gb');
    const sources = parsed.annotations.filter((annotation) => annotation.type === 'source');
    expect(sources).toHaveLength(1);
    expect([sources[0].start, sources[0].end]).toEqual([1, parsed.length]);
  });

  for (const fixtureName of fixtures) {
    describe(fixtureName, () => {
      let original: AnnotatedSequence;

      beforeAll(() => {
        original = loadFixture(fixtureName).parsed;
      });

      it('preserves sequence on round-trip', () => {
        const serialized = serializeGenBank(original);
        const reparsed = parseGenBankFull(serialized);
        expect(reparsed.sequence.toLowerCase()).toBe(original.sequence.toLowerCase());
      });

      it('preserves topology on round-trip', () => {
        const serialized = serializeGenBank(original);
        const reparsed = parseGenBankFull(serialized);
        expect(reparsed.circular).toBe(original.circular);
      });

      it('preserves annotation count on round-trip', () => {
        const serialized = serializeGenBank(original);
        const reparsed = parseGenBankFull(serialized);
        expect(reparsed.annotations.length).toBe(original.annotations.length);
      });

      it('preserves annotation names on round-trip', () => {
        const serialized = serializeGenBank(original);
        const reparsed = parseGenBankFull(serialized);
        for (let i = 0; i < original.annotations.length; i++) {
          expect(reparsed.annotations[i].name).toBe(original.annotations[i].name);
        }
      });

      it('preserves annotation positions on round-trip', () => {
        const serialized = serializeGenBank(original);
        const reparsed = parseGenBankFull(serialized);
        for (let i = 0; i < original.annotations.length; i++) {
          expect(reparsed.annotations[i].start).toBe(original.annotations[i].start);
          expect(reparsed.annotations[i].end).toBe(original.annotations[i].end);
        }
      });

      it('preserves annotation directions on round-trip', () => {
        const serialized = serializeGenBank(original);
        const reparsed = parseGenBankFull(serialized);
        for (let i = 0; i < original.annotations.length; i++) {
          expect(reparsed.annotations[i].direction).toBe(original.annotations[i].direction);
        }
      });
    });
  }
});

describe('single edit → serialize → re-parse', () => {
  let original: AnnotatedSequence;

  beforeAll(() => {
    original = loadFixture('pUC19.gb').parsed;
  });

  it('insert at beginning: sequence is correct', () => {
    const edited = insertBases(original, 0, 'AAAA');
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.sequence.slice(0, 4).toLowerCase()).toBe('aaaa');
    expect(reparsed.length).toBe(original.length + 4);
  });

  it('insert at middle: sequence is correct', () => {
    const mid = Math.floor(original.length / 2);
    const edited = insertBases(original, mid, 'CCCC');
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.length).toBe(original.length + 4);
    expect(reparsed.sequence.slice(mid, mid + 4).toLowerCase()).toBe('cccc');
  });

  it('insert at end: sequence is correct', () => {
    const edited = insertBases(original, original.length, 'TTTT');
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.length).toBe(original.length + 4);
    expect(reparsed.sequence.slice(-4).toLowerCase()).toBe('tttt');
  });

  it('delete at beginning: sequence is correct', () => {
    const edited = deleteBases(original, 0, 10);
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.length).toBe(original.length - 10);
    expect(reparsed.sequence.toLowerCase()).toBe(original.sequence.slice(10).toLowerCase());
  });

  it('delete at end: sequence is correct', () => {
    const edited = deleteBases(original, original.length - 10, original.length);
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.length).toBe(original.length - 10);
  });

  it('substitute single base: sequence is correct', () => {
    const pos = 100;
    const originalBase = original.sequence[pos];
    const newBase = originalBase.toLowerCase() === 'a' ? 'T' : 'A';
    const edited = substituteBases(original, pos, newBase);
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.length).toBe(original.length);
    expect(reparsed.sequence[pos].toLowerCase()).toBe(newBase.toLowerCase());
  });

  it('substitute multiple bases: sequence is correct', () => {
    const edited = substituteBases(original, 50, 'NNNN');
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.length).toBe(original.length);
    expect(reparsed.sequence.slice(50, 54).toLowerCase()).toBe('nnnn');
  });
});

describe('sequential edits: edit → save → edit → save', () => {
  let original: AnnotatedSequence;

  beforeAll(() => {
    original = loadFixture('pUC19.gb').parsed;
  });

  it('two insertions: both are preserved', () => {
    const edit1 = insertBases(original, 100, 'AAAA');
    const saved1 = parseGenBankFull(serializeGenBank(edit1));

    const edit2 = insertBases(saved1, 200, 'CCCC');
    const saved2 = parseGenBankFull(serializeGenBank(edit2));

    expect(saved2.length).toBe(original.length + 8);
    expect(saved2.sequence.slice(100, 104).toLowerCase()).toBe('aaaa');
    expect(saved2.sequence.slice(200, 204).toLowerCase()).toBe('cccc');
  });

  it('insert then delete: net result is correct', () => {
    const edit1 = insertBases(original, 100, 'GGGG');
    const saved1 = parseGenBankFull(serializeGenBank(edit1));

    const edit2 = deleteBases(saved1, 100, 104);
    const saved2 = parseGenBankFull(serializeGenBank(edit2));

    expect(saved2.length).toBe(original.length);
    expect(saved2.sequence.toLowerCase()).toBe(original.sequence.toLowerCase());
  });

  it('edit → save → revert to WT: matches original', () => {
    const edited = insertBases(original, 500, 'ATCGATCG');
    const _saved = serializeGenBank(edited);

    const reverted = serializeGenBank(original);
    const reparsed = parseGenBankFull(reverted);

    expect(reparsed.sequence.toLowerCase()).toBe(original.sequence.toLowerCase());
    expect(reparsed.length).toBe(original.length);
    expect(reparsed.annotations.length).toBe(original.annotations.length);
  });

  it('three sequential edits preserve all changes', () => {
    const edit1 = insertBases(original, 0, 'AA');
    const saved1 = parseGenBankFull(serializeGenBank(edit1));

    const edit2 = substituteBases(saved1, 50, 'TT');
    const saved2 = parseGenBankFull(serializeGenBank(edit2));

    const edit3 = deleteBases(saved2, saved2.length - 5, saved2.length);
    const saved3 = parseGenBankFull(serializeGenBank(edit3));

    expect(saved3.length).toBe(original.length + 2 - 5);
    expect(saved3.sequence.slice(0, 2).toLowerCase()).toBe('aa');
    expect(saved3.sequence.slice(50, 52).toLowerCase()).toBe('tt');
  });
});

describe('annotation positions after sequence edits', () => {
  let original: AnnotatedSequence;

  beforeAll(() => {
    original = loadFixture('pUC19.gb').parsed;
  });

  it('insertion before annotation shifts it forward', () => {
    const ann = original.annotations.find((a) => a.start > 500);
    if (!ann) throw new Error('No annotation found past position 500');

    const insertPos = 100;
    const edited = insertBases(original, insertPos, 'AAAA');
    const saved = parseGenBankFull(serializeGenBank(edited));

    const savedAnn = saved.annotations.find((a) => a.name === ann.name);
    expect(savedAnn).toBeDefined();
    expect(savedAnn!.start).toBe(ann.start + 4);
    expect(savedAnn!.end).toBe(ann.end + 4);
  });

  it('deletion before annotation shifts it backward', () => {
    const ann = original.annotations.find((a) => a.start > 500);
    if (!ann) throw new Error('No annotation found past position 500');

    const edited = deleteBases(original, 50, 60);
    const saved = parseGenBankFull(serializeGenBank(edited));

    const savedAnn = saved.annotations.find((a) => a.name === ann.name);
    expect(savedAnn).toBeDefined();
    expect(savedAnn!.start).toBe(ann.start - 10);
    expect(savedAnn!.end).toBe(ann.end - 10);
  });

  it('substitution does not shift annotations', () => {
    const ann = original.annotations[0];
    const edited = substituteBases(original, 0, 'AAAA');
    const saved = parseGenBankFull(serializeGenBank(edited));

    const savedAnn = saved.annotations.find((a) => a.name === ann.name);
    expect(savedAnn).toBeDefined();
    expect(savedAnn!.start).toBe(ann.start);
    expect(savedAnn!.end).toBe(ann.end);
  });

  it('complement annotations preserve direction on round-trip', () => {
    const reverseAnns = original.annotations.filter((a) => a.direction === -1);
    if (reverseAnns.length === 0) return;

    const serialized = serializeGenBank(original);
    const reparsed = parseGenBankFull(serialized);

    for (const ann of reverseAnns) {
      const match = reparsed.annotations.find((a) => a.name === ann.name);
      expect(match).toBeDefined();
      expect(match!.direction).toBe(-1);
    }
  });
});

describe('linear sequence handling', () => {
  let original: AnnotatedSequence;

  beforeAll(() => {
    original = loadFixture('sfgfp-cds.gb').parsed;
  });

  it('linear topology is preserved', () => {
    expect(original.circular).toBe(false);
    const serialized = serializeGenBank(original);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.circular).toBe(false);
  });

  it('edit and save preserves linear topology', () => {
    const edited = insertBases(original, 100, 'ATCG');
    const serialized = serializeGenBank(edited);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.circular).toBe(false);
    expect(reparsed.length).toBe(original.length + 4);
  });
});

describe('qualifier handling on round-trip', () => {
  it('embedded quotes survive round-trip', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'QuoteTest',
      sequence: 'atcgatcgatcgatcgatcg',
      length: 20,
      circular: true,
      annotations: [
        {
          name: 'Test',
          type: 'CDS',
          start: 1,
          end: 20,
          direction: 1,
          qualifiers: { note: ['has "quoted" text'] },
        },
      ],
    };

    const serialized = serializeGenBank(seq);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.annotations[0].qualifiers?.note).toEqual(['has "quoted" text']);
  });

  it('preserves an unbroken qualifier token instead of imposing a destructive line break', () => {
    const longNote = 'A'.repeat(200);
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'LongNote',
      sequence: 'atcgatcg',
      length: 8,
      circular: true,
      annotations: [
        {
          name: 'Test',
          type: 'CDS',
          start: 1,
          end: 8,
          direction: 1,
          qualifiers: { note: [longNote] },
        },
      ],
    };

    const serialized = serializeGenBank(seq);
    expect(serialized).toContain(`/note="${longNote}"`);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.annotations[0].qualifiers?.note?.[0]).toBe(longNote);
  });
});

describe('annotation within deleted region', () => {
  let original: AnnotatedSequence;

  beforeAll(() => {
    original = loadFixture('pUC19.gb').parsed;
  });

  it('annotation entirely within deleted region is removed', () => {
    const ann = original.annotations.find((a) => a.end - a.start < 200 && a.start > 100);
    if (!ann) return;

    const edited = deleteBases(original, ann.start - 10, ann.end + 10);
    const saved = parseGenBankFull(serializeGenBank(edited));

    const match = saved.annotations.find((a) => a.name === ann.name);
    expect(match).toBeUndefined();
  });
});

describe('insert within annotation extends it', () => {
  it('inserting inside annotation shifts its end', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'InsertWithin',
      sequence: 'atcgatcgatcgatcgatcgatcgatcgatcgatcgatcg',
      length: 40,
      circular: true,
      annotations: [{ name: 'Gene1', type: 'CDS', start: 5, end: 30, direction: 1 }],
    };

    const edited = insertBases(seq, 15, 'AAAA');
    const saved = parseGenBankFull(serializeGenBank(edited));

    expect(saved.annotations[0].start).toBe(5);
    expect(saved.annotations[0].end).toBe(34);
    expect(saved.length).toBe(44);
  });
});

describe('LOCUS line length accuracy after edits', () => {
  let original: AnnotatedSequence;

  beforeAll(() => {
    original = loadFixture('pUC19.gb').parsed;
  });

  it('LOCUS length matches actual sequence after insert', () => {
    const edited = insertBases(original, 100, 'ATCGATCGATCG');
    const serialized = serializeGenBank(edited);

    const locusLine = serialized.split('\n')[0];
    const locusLength = parseInt(locusLine.match(/(\d+)\s+bp/)?.[1] || '0', 10);

    const reparsed = parseGenBankFull(serialized);

    expect(locusLength).toBe(reparsed.sequence.length);
    expect(locusLength).toBe(original.length + 12);
  });

  it('LOCUS length matches actual sequence after delete', () => {
    const edited = deleteBases(original, 100, 200);
    const serialized = serializeGenBank(edited);

    const locusLine = serialized.split('\n')[0];
    const locusLength = parseInt(locusLine.match(/(\d+)\s+bp/)?.[1] || '0', 10);
    const reparsed = parseGenBankFull(serialized);

    expect(locusLength).toBe(reparsed.sequence.length);
    expect(locusLength).toBe(original.length - 100);
  });
});

describe('empty and edge-value sequences', () => {
  it('serialize empty annotations array', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'NoAnns',
      sequence: 'atcgatcg',
      length: 8,
      circular: true,
      annotations: [],
    };
    const serialized = serializeGenBank(seq);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.annotations).toEqual([]);
    expect(reparsed.sequence.toLowerCase()).toBe('atcgatcg');
  });

  it('single base sequence', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'SingleBase',
      sequence: 'a',
      length: 1,
      circular: false,
      annotations: [],
    };
    const serialized = serializeGenBank(seq);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.sequence).toBe('a');
    expect(reparsed.length).toBe(1);
  });

  it('non-standard IUPAC bases round-trip', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'IUPAC',
      sequence: 'atcgNNNRYWSMKBDHV',
      length: 17,
      circular: true,
      annotations: [],
    };
    const serialized = serializeGenBank(seq);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.sequence.toLowerCase()).toBe('atcgnnnrywsmkbdhv');
  });
});

describe('multiple overlapping annotations', () => {
  it('two overlapping annotations both survive round-trip', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'Overlap',
      sequence: 'atcgatcgatcgatcgatcgatcgatcgatcg',
      length: 32,
      circular: true,
      annotations: [
        { name: 'Gene1', type: 'CDS', start: 1, end: 20, direction: 1 },
        { name: 'Gene2', type: 'CDS', start: 10, end: 30, direction: -1 },
      ],
    };
    const serialized = serializeGenBank(seq);
    const reparsed = parseGenBankFull(serialized);
    expect(reparsed.annotations).toHaveLength(2);
    expect(reparsed.annotations.find((a) => a.name === 'Gene1')).toBeDefined();
    expect(reparsed.annotations.find((a) => a.name === 'Gene2')).toBeDefined();
  });

  it('insert before overlapping annotations shifts both', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'OverlapShift',
      sequence: 'atcgatcgatcgatcgatcgatcgatcgatcg',
      length: 32,
      circular: true,
      annotations: [
        { name: 'Gene1', type: 'CDS', start: 10, end: 20, direction: 1 },
        { name: 'Gene2', type: 'CDS', start: 15, end: 25, direction: -1 },
      ],
    };
    const edited = insertBases(seq, 5, 'AAAA');
    const saved = parseGenBankFull(serializeGenBank(edited));
    const g1 = saved.annotations.find((a) => a.name === 'Gene1');
    const g2 = saved.annotations.find((a) => a.name === 'Gene2');
    expect(g1!.start).toBe(14);
    expect(g1!.end).toBe(24);
    expect(g2!.start).toBe(19);
    expect(g2!.end).toBe(29);
  });
});

describe('real fixture annotation count stability', () => {
  it('pUC19.gb preserves annotation count through 3 sequential edits', () => {
    let seq = loadFixture('pUC19.gb').parsed;
    const originalAnnCount = seq.annotations.length;

    seq = parseGenBankFull(serializeGenBank(insertBases(seq, 0, 'AAAA')));
    expect(seq.annotations.length).toBe(originalAnnCount);

    seq = parseGenBankFull(serializeGenBank(substituteBases(seq, 500, 'TTTT')));
    expect(seq.annotations.length).toBe(originalAnnCount);

    seq = parseGenBankFull(serializeGenBank(insertBases(seq, seq.length, 'CCCC')));
    expect(seq.annotations.length).toBe(originalAnnCount);
  });
});
