import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { describe, expect, it } from 'vitest';
import {
  loadReadonlyGenBank,
  loadReadonlySequence,
  type ReadonlyGenBankLoadResult,
  type ReadonlySequenceLoadResult,
} from './index';

const PUC19_PATH = fileURLToPath(
  new URL('../../../../test-fixtures/sequences/circular/pUC19.gb', import.meta.url)
);

const ANNOTATION_CORPUS = [
  'circular/pUC19.gb',
  'circular/origin-wrap-join-synthetic.gb',
  'linear/mg1655-thrL-multi-xref-synthetic.gb',
  'linear/ecoli-mg1655-region.gb',
  'linear/structure-s288c-seo1-ape-label.gb',
] as const;

const QUOTED_QUALIFIERS = `LOCUS       quoted                     8 bp    DNA     linear
FEATURES             Location/Qualifiers
     misc_feature    1..4
                     /label="Quoted ""feature"""
                     /note="note: note=""synthetic"" translation=""EL"""
ORIGIN
        1 atcgatcg
//`;

const SLASH_CONTINUATION = `LOCUS       slash                      8 bp    DNA     linear
FEATURES             Location/Qualifiers
     misc_feature    1..4
                     /label="URL feature"
                     /note="This source value is deliberately wrapped immediately before
                     /the/path so the slash cannot be parsed as another qualifier."
ORIGIN
        1 atcgatcg
//`;

const RNA_DIRECTIONS = `LOCUS       rna                      200 bp    DNA     linear
FEATURES             Location/Qualifiers
     ncRNA           1..20
                     /label="forward ncRNA"
     misc_RNA        21..40
                     /label="forward misc RNA"
     rRNA            complement(41..60)
                     /label="reverse rRNA"
ORIGIN
        1 ${'atcgatcg'.repeat(25)}
//`;

const PRIMER_CASES = `LOCUS       primers                   32 bp    DNA     circular
FEATURES             Location/Qualifiers
     primer_bind     1..4
                     /label="explicit forward"
                     /note="sequence: ACGA"
     primer          complement(29..32)
                     /label="explicit reverse boundary"
                     /note="sequence: GcTA"
     primer_bind     9..12
                     /label="template forward"
     primer          complement(13..16)
                     /label="template reverse"
     primer_bind     join(17..18,21..22)
                     /label="joined template"
     primer          complement(join(1..4,29..32))
                     /label="origin-wrap template reverse"
     primer_bind     complement(join(1..4,29..32))
                     /label="origin-wrap explicit reverse"
                     /note="sequence: AcgTgcTa"
ORIGIN
        1 acgtttaatg caaagcgatc cacccccctt gc
//`;

function expectLoaded(
  result: ReadonlyGenBankLoadResult
): Extract<ReadonlyGenBankLoadResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result;
}

describe('loadReadonlyGenBank', () => {
  it('parses exact GenBank bytes into the scientific document model', () => {
    const result = expectLoaded(
      loadReadonlyGenBank({ kind: 'bytes', bytes: readFileSync(PUC19_PATH) })
    );

    expect(result.plasmid).toMatchObject({
      name: 'SYNPUC19CV',
      length: 2686,
      circular: true,
    });
    expect(result.plasmid.features.length).toBeGreaterThan(0);
    expect(result.plasmid.features.some((feature) => feature.displayName === 'AmpR')).toBe(true);
  });

  it('preserves parsed plasmid and annotation identity', () => {
    const parsed = expectLoaded(
      loadReadonlyGenBank({ kind: 'bytes', bytes: readFileSync(PUC19_PATH) })
    ).plasmid;
    const firstFeature = parsed.features[0];

    const result = expectLoaded(loadReadonlyGenBank({ kind: 'parsed', plasmid: parsed }));

    expect(result.plasmid).toBe(parsed);
    expect(result.plasmid.features[0]).toBe(firstFeature);
  });

  it('uses the shared qualifier interpretation for quoted and wrapped values', () => {
    const quoted = expectLoaded(
      loadReadonlyGenBank({
        kind: 'bytes',
        bytes: new TextEncoder().encode(QUOTED_QUALIFIERS),
      })
    );
    const slash = expectLoaded(
      loadReadonlyGenBank({
        kind: 'bytes',
        bytes: new TextEncoder().encode(SLASH_CONTINUATION),
      })
    );

    expect(quoted.plasmid.features[0]).toMatchObject({
      displayName: 'Quoted "feature"',
      qualifiers: {
        label: ['Quoted "feature"'],
        note: ['note: note="synthetic" translation="EL"'],
      },
    });
    expect(slash.plasmid.features[0].qualifiers).toEqual({
      label: ['URL feature'],
      note: [
        'This source value is deliberately wrapped immediately before/the/path so the slash cannot be parsed as another qualifier.',
      ],
    });
  });

  it('uses the shared direction interpretation for forward and reverse RNA features', () => {
    const loaded = expectLoaded(
      loadReadonlyGenBank({ kind: 'bytes', bytes: new TextEncoder().encode(RNA_DIRECTIONS) })
    );

    expect(
      loaded.plasmid.features.map(({ displayName, direction }) => ({ displayName, direction }))
    ).toEqual([
      { displayName: 'forward ncRNA', direction: 'forward' },
      { displayName: 'forward misc RNA', direction: 'forward' },
      { displayName: 'reverse rRNA', direction: 'reverse' },
    ]);
  });

  it.each(ANNOTATION_CORPUS)('matches shared annotation facts for %s', (fixture) => {
    const content = readFileSync(
      fileURLToPath(new URL(`../../../../test-fixtures/sequences/${fixture}`, import.meta.url)),
      'utf8'
    );
    const shared = parseGenBankFull(content).annotations.filter(
      (annotation) => annotation.type !== 'primer' && annotation.type !== 'primer_bind'
    );
    const loaded = expectLoaded(
      loadReadonlyGenBank({ kind: 'bytes', bytes: new TextEncoder().encode(content) })
    );

    expect(
      loaded.plasmid.features.map((feature) => ({
        name: feature.displayName,
        type: feature.type,
        start: feature.start,
        end: feature.end,
        direction: feature.direction,
        segments: feature.segments,
        qualifiers: feature.qualifiers,
      }))
    ).toEqual(
      shared.map((annotation) => ({
        name: annotation.name,
        type: annotation.type,
        start: annotation.start,
        end: annotation.end,
        direction:
          annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none',
        segments: annotation.segments,
        qualifiers: annotation.qualifiers ?? {},
      }))
    );
  });

  it('preserves explicit and template-derived primers in both directions', () => {
    const loaded = expectLoaded(
      loadReadonlyGenBank({ kind: 'bytes', bytes: new TextEncoder().encode(PRIMER_CASES) })
    );

    expect(
      loaded.plasmid.primers.map(
        ({ name, start, end, direction, bases, hasExplicitSequence, mismatches }) => ({
          name,
          start,
          end,
          direction,
          bases,
          hasExplicitSequence,
          mismatches,
        })
      )
    ).toEqual([
      {
        name: 'explicit forward',
        start: 0,
        end: 4,
        direction: 'forward',
        bases: 'ACGA',
        hasExplicitSequence: true,
        mismatches: [{ position: 3, oligoBase: 'A', templateBase: 't' }],
      },
      {
        name: 'explicit reverse boundary',
        start: 28,
        end: 32,
        direction: 'reverse',
        bases: 'GcTA',
        hasExplicitSequence: true,
        mismatches: [{ position: 2, oligoBase: 'T', templateBase: 'a' }],
      },
      {
        name: 'template forward',
        start: 8,
        end: 12,
        direction: 'forward',
        bases: 'tgca',
        hasExplicitSequence: false,
        mismatches: [],
      },
      {
        name: 'template reverse',
        start: 12,
        end: 16,
        direction: 'reverse',
        bases: 'gctt',
        hasExplicitSequence: false,
        mismatches: [],
      },
      {
        name: 'joined template',
        start: 16,
        end: 22,
        direction: 'forward',
        bases: 'gatcca',
        hasExplicitSequence: false,
        mismatches: [],
      },
      {
        name: 'origin-wrap template reverse',
        start: 28,
        end: 4,
        direction: 'reverse',
        bases: 'acgtgcaa',
        hasExplicitSequence: false,
        mismatches: [],
      },
      {
        name: 'origin-wrap explicit reverse',
        start: 28,
        end: 4,
        direction: 'reverse',
        bases: 'AcgTgcTa',
        hasExplicitSequence: true,
        mismatches: [{ position: 6, oligoBase: 'T', templateBase: 'a' }],
      },
    ]);
  });

  it('returns a typed recoverable error for invalid UTF-8', () => {
    const result = loadReadonlyGenBank({
      kind: 'bytes',
      bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_ENCODING',
        message: 'GenBank bytes must be valid UTF-8.',
      },
    });
  });

  it('returns a typed recoverable error for unsupported text', () => {
    const result = loadReadonlyGenBank({
      kind: 'bytes',
      bytes: new TextEncoder().encode('FASTA is not GenBank'),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'UNSUPPORTED_FORMAT',
        message: 'Only DNA GenBank input is supported.',
      },
    });
  });

  it('returns the unsupported-format error for protein GenBank input', () => {
    const result = loadReadonlyGenBank({
      kind: 'bytes',
      bytes: new TextEncoder().encode(
        'LOCUS       PROTEIN     3 aa     linear\nORIGIN\n        1 XYZ\n//'
      ),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'UNSUPPORTED_FORMAT',
        message: 'Only DNA GenBank input is supported.',
      },
    });
  });

  it('returns invalid GenBank for non-nucleotide ORIGIN content', () => {
    const result = loadReadonlyGenBank({
      kind: 'bytes',
      bytes: new TextEncoder().encode(
        'LOCUS       NOT_DNA     3 bp     linear\nORIGIN\n        1 XYZ\n//'
      ),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_GENBANK',
        message: 'GenBank input does not contain a renderable sequence.',
      },
    });
  });

  it('returns invalid GenBank when LOCUS length disagrees with the full sequence', () => {
    const result = loadReadonlyGenBank({
      kind: 'bytes',
      bytes: new TextEncoder().encode(
        'LOCUS       BROKEN      100 bp    DNA     linear\nORIGIN\n        1 ACG\n//'
      ),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_GENBANK',
        message: 'GenBank input does not contain a renderable sequence.',
      },
    });
  });

  it('returns a typed recoverable error when GenBank has no sequence', () => {
    const result = loadReadonlyGenBank({
      kind: 'bytes',
      bytes: new TextEncoder().encode('LOCUS       EMPTY       0 bp    DNA     linear\nORIGIN\n//'),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_GENBANK',
        message: 'GenBank input does not contain a renderable sequence.',
      },
    });
  });

  it('returns the same typed error for an empty parsed plasmid', () => {
    const result = loadReadonlyGenBank({
      kind: 'parsed',
      plasmid: {
        name: 'empty',
        length: 0,
        circular: false,
        sequence: '',
        features: [],
        primers: [],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_GENBANK',
        message: 'GenBank input does not contain a renderable sequence.',
      },
    });
  });

  it('rejects parsed metadata that declares bases without sequence content', () => {
    const result = loadReadonlyGenBank({
      kind: 'parsed',
      plasmid: {
        name: 'metadata-only',
        length: 42,
        circular: false,
        sequence: '',
        features: [],
        primers: [],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_GENBANK',
        message: 'GenBank input does not contain a renderable sequence.',
      },
    });
  });

  it('preserves a parsed plasmid backed by a streamed sequence window', () => {
    const streamed = {
      name: 'streamed',
      length: 42,
      circular: false,
      sequence: '',
      sequenceWindow: { startBp: 10, bases: 'ACGTRYN' },
      features: [],
      primers: [],
    };

    const result = expectLoaded(loadReadonlyGenBank({ kind: 'parsed', plasmid: streamed }));

    expect(result.plasmid).toBe(streamed);
  });

  it('rejects parsed input when full sequence length disagrees with metadata', () => {
    const result = loadReadonlyGenBank({
      kind: 'parsed',
      plasmid: {
        name: 'mismatched',
        length: 42,
        circular: false,
        sequence: 'ACG',
        features: [],
        primers: [],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_GENBANK',
        message: 'GenBank input does not contain a renderable sequence.',
      },
    });
  });
});

function expectSequenceLoaded(
  result: ReadonlySequenceLoadResult
): Extract<ReadonlySequenceLoadResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result;
}

describe('loadReadonlySequence', () => {
  it('renders a FASTA publication as a linear, annotation-free map', () => {
    const result = expectSequenceLoaded(
      loadReadonlySequence({
        kind: 'bytes',
        filename: 'shared-sequence.fasta',
        bytes: new TextEncoder().encode('>shared-sequence\nACGTACGTNN\n'),
      })
    );

    expect(result.plasmid).toMatchObject({
      name: 'shared-sequence',
      length: 10,
      circular: false,
      sequence: 'ACGTACGTNN',
      features: [],
      primers: [],
    });
  });

  it('rejects formats whose browser map would hide quality or trace semantics', () => {
    const result = loadReadonlySequence({
      kind: 'bytes',
      filename: 'shared-read.fastq',
      bytes: new TextEncoder().encode('@read\nACGT\n+\n!!!!\n'),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'UNSUPPORTED_FORMAT',
        message: 'Only FASTA and SEQ sequence-only publications have a browser map preview.',
      },
    });
  });
});
