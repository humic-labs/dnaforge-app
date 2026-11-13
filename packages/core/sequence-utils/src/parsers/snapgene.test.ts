import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectFormat, parseSequenceFile } from './index';
import { isSnapGeneFormat, parseSnapGene } from './snapgene';

const SAMPLE_F =
  [
    resolve(process.cwd(), 'test-fixtures/sequences/snapgene/sample-f.dna'),
    resolve(process.cwd(), '../../test-fixtures/sequences/snapgene/sample-f.dna'),
    resolve(process.cwd(), '../../../test-fixtures/sequences/snapgene/sample-f.dna'),
  ].find((candidate) => existsSync(candidate)) ??
  resolve(process.cwd(), 'test-fixtures/sequences/snapgene/sample-f.dna');

describe('SnapGene parser', () => {
  it('detects public SnapGene .dna files by cookie and filename', () => {
    const bytes = readFileSync(SAMPLE_F);

    expect(isSnapGeneFormat(bytes)).toBe(true);
    expect(detectFormat(bytes)).toBe('snapgene');
    expect(detectFormat(bytes, 'sample-f.dna')).toBe('snapgene');
  });

  it('decodes sequence, circular topology, features, primers, and notes', () => {
    const bytes = readFileSync(SAMPLE_F);

    const parsed = parseSnapGene(bytes, 'sample-f.dna');
    const annotationsByName = new Map(
      parsed.annotations.map((annotation) => [annotation.name, annotation])
    );

    expect(parsed.name).toBe('Sample');
    expect(parsed.description).toBe('Sample Sequence F');
    expect(parsed.sequence).toHaveLength(1000);
    expect(parsed.circular).toBe(true);
    expect(parsed.annotations).toHaveLength(3);

    expect(annotationsByName.get('FeatureB')).toMatchObject({
      type: 'terminator',
      start: 400,
      end: 724,
      direction: -1,
      segments: [
        { start: 635, end: 724 },
        { start: 517, end: 634 },
        { start: 400, end: 499 },
      ],
      qualifiers: {
        label: ['FeatureB'],
        note: ['An example of a reverse-strand split feature'],
        parts: ['1:subfeature1;3:subfeature3'],
      },
    });
    expect(annotationsByName.get('FeatureA')).toMatchObject({
      type: 'rep_origin',
      start: 161,
      end: 241,
      direction: 1,
      segments: [
        { start: 161, end: 180 },
        { start: 188, end: 207 },
        { start: 215, end: 241 },
      ],
      qualifiers: {
        label: ['FeatureA'],
        note: ['An example of a split feature'],
        parts: ['2:subfeature2'],
      },
    });
    expect(annotationsByName.get('Primer 1')).toMatchObject({
      type: 'primer_bind',
      start: 752,
      end: 776,
      direction: 1,
      qualifiers: {
        label: ['Primer 1'],
        sequence: ['aaataaaaaacgattgaaggttaca'],
      },
    });
  });

  it('routes .dna through the unified parser without falling through to text sniffing', () => {
    const bytes = readFileSync(SAMPLE_F);

    const [parsed] = parseSequenceFile(bytes, { filename: 'sample-f.dna' });

    expect(parsed.format).toBe('snapgene');
    expect(parsed.name).toBe('Sample');
    expect(parsed.sequence).toHaveLength(1000);
    expect(parsed.metadata).toMatchObject({
      circular: true,
      annotationCount: 3,
    });
  });
});
