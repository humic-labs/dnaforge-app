import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  parseGenBankFull,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';

import { buildWholeEntityDescriptor } from './whole-entity';
import type { SequenceDescriptorInput } from './types';

const REPO_ROOT = join(__dirname, '../../../../../..');
const PUC19_PATH = join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb');

const puc19: AnnotatedSequence = parseGenBankFull(readFileSync(PUC19_PATH, 'utf8'));

function wholeEntityInput(documentId: string): SequenceDescriptorInput {
  return { kind: 'whole_entity', documentId };
}

function recomputeHistogram(annotations: Annotation[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const a of annotations) h[a.type] = (h[a.type] ?? 0) + 1;
  return h;
}

describe('whole_entity — SELDESC v2 envelope shape', () => {
  it('carries the v2 envelope, bases:never, and passes sourceVersion through verbatim', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 42);
    expect(d.schemaVersion).toBe(2);
    expect(d.kind).toBe('whole_entity');
    expect(d.bases).toBe('never');
    expect(d.coordinateSystem).toBe('1-indexed-inclusive');
    expect(d.sourceVersion).toBe(42);
    expect(d.locator.documentId).toBe(PUC19_PATH);
    expect(d.fetch.tools).toEqual(expect.arrayContaining(['find_features', 'get_sequence']));
    expect(d.fetch.rawFallback).toBeUndefined();
  });

  it('sourceVersion is a NUMBER (drift counter), never a content hash', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 7);
    expect(typeof d.sourceVersion).toBe('number');
    const serialized = JSON.stringify(d);
    expect(serialized).not.toMatch(/"(hash|sha256|sha1|contentHash|checksum)"/i);
  });
});

describe('whole_entity — metadata + featureHistogram + landmarks ONLY', () => {
  it('measured carries the whole-file summary fields and NONE of the region-only fields', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 1);
    const measured = d.measured as Record<string, unknown>;

    expect(measured).toHaveProperty('featureHistogram');
    expect(measured).toHaveProperty('landmarks');
    expect(measured).toHaveProperty('featureCount');
    expect(measured).toHaveProperty('metadataAvailable');
    expect(measured).toHaveProperty('functionalGistIsInferred');

    expect(measured).not.toHaveProperty('gcPercentWholeSelection');
    expect(measured).not.toHaveProperty('gcComputed');
    expect(measured).not.toHaveProperty('readingFrames');
    expect(measured).not.toHaveProperty('overlappingFeatures');
    expect(measured).not.toHaveProperty('boundaryFlags');
  });

  it('topology + length + featureCount match the real parsed pUC19 record', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 1);
    expect(d.measured.topology).toBe('circular');
    expect(d.measured.length).toBe(puc19.length);
    expect(d.measured.featureCount).toBe(puc19.annotations.length);
  });

  it('featureHistogram counts every feature by type and sums to featureCount', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 1);
    expect(d.measured.featureHistogram).toEqual(recomputeHistogram(puc19.annotations));
    const total = Object.values(d.measured.featureHistogram).reduce((a, b) => a + b, 0);
    expect(total).toBe(d.measured.featureCount);
    expect(d.measured.featureHistogram.CDS).toBeGreaterThan(0);
  });

  it('landmarks are named notable features (capped), drawn from the real feature names', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 1);
    const landmarks = d.measured.landmarks;
    expect(Array.isArray(landmarks)).toBe(true);
    expect(landmarks.length).toBeGreaterThan(0);
    expect(landmarks.length).toBeLessThanOrEqual(20);
    landmarks.forEach((name) => expect(typeof name).toBe('string'));
    const known = new Set(
      puc19.annotations.flatMap((a) =>
        [
          a.name,
          a.label,
          a.qualifiers?.label?.[0],
          a.qualifiers?.gene?.[0],
          a.qualifiers?.product?.[0],
        ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      )
    );
    landmarks.forEach((name) => expect(known.has(name)).toBe(true));
    expect(landmarks.some((n) => /lac|bla|amp/i.test(n))).toBe(true);
  });

  it('metadataAvailable: definition present, taxonId absent (never inferred)', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 1);
    expect(d.measured.metadataAvailable.definition).toBe(true);
    expect(d.measured.metadataAvailable.taxonId).toBe(false);
    expect(typeof d.measured.metadataAvailable.organism).toBe('boolean');
  });

  it('functionalGist is flagged as an inference when CDS names are present', () => {
    const d = buildWholeEntityDescriptor(wholeEntityInput(PUC19_PATH), puc19, 1);
    expect(d.measured.functionalGistIsInferred).toBe(true);
    if (d.fileText.functionalGist) {
      expect(d.fileText.functionalGist.trust).toBe('untrusted-data');
    }
  });
});

describe('whole_entity — magnitude routing: O(feature-index), NEVER O(length)', () => {
  it('builds a full card from a 4.6 Mb-length entity with EMPTY raw bases (never reads/slices bases)', () => {
    const genomeLength = 4_641_652;
    const syntheticGenome: AnnotatedSequence = {
      id: 'synthetic-genome',
      name: 'Synthetic 4.6 Mb chromosome',
      sequence: '',
      length: genomeLength,
      circular: true,
      description: 'Synthetic magnitude-guard fixture',
      annotations: [
        {
          name: 'thrA',
          type: 'CDS',
          start: 337,
          end: 2799,
          direction: 1,
          qualifiers: { gene: ['thrA'], product: ['aspartokinase'] },
        },
        {
          name: 'thrB',
          type: 'CDS',
          start: 2801,
          end: 3733,
          direction: 1,
          qualifiers: { gene: ['thrB'] },
        },
        { name: 'oriC', type: 'rep_origin', start: 3_925_744, end: 3_925_975, direction: 1 },
        { name: 'a promoter', type: 'promoter', start: 100, end: 200, direction: 1 },
        { name: 'misc', type: 'misc_feature', start: 500, end: 600, direction: 1 },
      ] as Annotation[],
    };

    const d = buildWholeEntityDescriptor(
      wholeEntityInput('/genomes/synthetic.gb'),
      syntheticGenome,
      3
    );

    expect(d.measured.length).toBe(genomeLength);
    expect(d.measured.topology).toBe('circular');
    expect(d.bases).toBe('never');
    expect(d.measured.featureCount).toBe(5);
    expect(d.measured.featureHistogram).toEqual(recomputeHistogram(syntheticGenome.annotations));
    expect(d.measured.landmarks.length).toBeGreaterThan(0);
    expect(d.measured.landmarks).not.toContain('misc');
    expect(d.measured.landmarks).toEqual(expect.arrayContaining(['thrA']));
    expect(d.measured as Record<string, unknown>).not.toHaveProperty('gcPercentWholeSelection');
  });
});
