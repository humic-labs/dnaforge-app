// @vitest-environment node

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { getFeatureColor } from '@waypoint/sequence-utils';
import {
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from './parse-sequence-file';

function readCanonicalPuc19(): string {
  const fixtureRelativePath = 'test-fixtures/sequences/circular/pUC19.gb';
  const fixturePath =
    [
      resolve(process.cwd(), fixtureRelativePath),
      resolve(process.cwd(), '../..', fixtureRelativePath),
    ].find((candidate) => existsSync(candidate)) ?? fixtureRelativePath;
  return readFileSync(fixturePath, 'utf8');
}

describe('parseTextSequenceFileAsAnnotated', () => {
  it('uses the desktop GenBank adapter for type-aware annotation colors', () => {
    const content = `LOCUS       S288C chromosome          80 bp    DNA     linear   SYN 01-JAN-2026
DEFINITION  Root-level chromosome fixture.
FEATURES             Location/Qualifiers
     promoter        1..10
                     /label="GAL1 promoter"
     CDS             complement(20..35)
                     /gene="lacZ"
     terminator      50..65
                     /label="CYC1 terminator"
     primer_bind     70..78
                     /label="Primer A"
ORIGIN
        1 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc
       61 atgcatgcat gcatgcatgc
//`;

    const parsed = parseTextSequenceFileAsAnnotated(content, '/project/root/chromosome.gb');
    const annotationsByType = new Map(parsed.sequence.annotations.map((ann) => [ann.type, ann]));

    expect(parsed.format).toBe('genbank');
    expect(parsed.sequence.name).toBe('S288C chromosome');
    expect(parsed.sequence.circular).toBe(false);
    expect(annotationsByType.get('promoter')?.color).toBe(getFeatureColor('promoter'));
    expect(annotationsByType.get('CDS')?.color).toBe(getFeatureColor('CDS'));
    expect(annotationsByType.get('terminator')?.color).toBe(getFeatureColor('terminator'));
    expect(annotationsByType.get('primer_bind')?.color).toBe(getFeatureColor('primer_bind'));
  });

  it('preserves real pUC19 circular topology and primer_bind annotations', () => {
    const content = readCanonicalPuc19();
    const parsed = parseTextSequenceFileAsAnnotated(content, '/project/root/pUC19.gb');
    const primerBinds = parsed.sequence.annotations.filter((ann) => ann.type === 'primer_bind');

    expect(parsed.format).toBe('genbank');
    expect(parsed.sequence.circular).toBe(true);
    expect(parsed.sequence.length).toBe(2686);
    expect(
      parsed.sequence.annotations.map(({ type, name, start, end, direction }) => ({
        type,
        name,
        start,
        end,
        direction,
      }))
    ).toEqual([
      { type: 'source', name: 'source', start: 1, end: 2686, direction: 0 },
      { type: 'CDS', name: 'lacZ-alpha', start: 146, end: 469, direction: -1 },
      { type: 'primer_bind', name: 'M13 fwd', start: 379, end: 395, direction: 0 },
      { type: 'misc_feature', name: 'MCS', start: 396, end: 452, direction: 0 },
      { type: 'primer_bind', name: 'M13 rev', start: 465, end: 481, direction: -1 },
      { type: 'protein_bind', name: 'lac operator', start: 489, end: 505, direction: -1 },
      { type: 'rep_origin', name: 'ori', start: 866, end: 866, direction: 0 },
      { type: 'CDS', name: 'AmpR', start: 1626, end: 2486, direction: -1 },
    ]);
    expect(primerBinds).toHaveLength(2);
    expect(primerBinds.every((ann) => ann.color === getFeatureColor('primer_bind'))).toBe(true);
  });

  it('preserves dense synthetic primer metadata and a wrapped origin on public pUC19 bases', () => {
    const canonicalContent = readCanonicalPuc19();
    const content = `LOCUS       SYN_PUC19_PRIMERS       2686 bp    DNA     circular SYN 01-JAN-2026
DEFINITION  Synthetic primer and wrapped-origin annotations on public L09137.2 bases.
FEATURES             Location/Qualifiers
     primer_bind     51..70
                     /label="Synthetic forward 1"
                     /direction="RIGHT"
     primer_bind     251..270
                     /label="Synthetic forward 2"
                     /direction="RIGHT"
     primer_bind     501..520
                     /label="Synthetic forward 3"
                     /direction="RIGHT"
     primer_bind     751..770
                     /label="Synthetic forward 4"
                     /direction="RIGHT"
     primer_bind     1001..1020
                     /label="Synthetic forward 5"
                     /direction="RIGHT"
     primer_bind     1251..1270
                     /label="Synthetic forward 6"
                     /direction="RIGHT"
     primer_bind     complement(1501..1520)
                     /label="Synthetic reverse 1"
     primer_bind     complement(1701..1720)
                     /label="Synthetic reverse 2"
     primer_bind     complement(1901..1920)
                     /label="Synthetic reverse 3"
     primer_bind     complement(2101..2120)
                     /label="Synthetic reverse 4"
     primer_bind     complement(2301..2320)
                     /label="Synthetic reverse 5"
     primer_bind     complement(2501..2520)
                     /label="Synthetic reverse 6"
     rep_origin      join(2315..2686,1..217)
                     /label="Synthetic wrapped origin"${canonicalContent.slice(canonicalContent.indexOf('\nORIGIN\n'))}`;
    const parsed = parseTextSequenceFileAsAnnotated(content, '/project/root/synthetic-primers.gb');
    const canonical = parseTextSequenceFileAsAnnotated(canonicalContent, '/project/root/pUC19.gb');
    const primerBinds = parsed.sequence.annotations.filter((ann) => ann.type === 'primer_bind');

    expect(parsed.format).toBe('genbank');
    expect(parsed.sequence.circular).toBe(true);
    expect(parsed.sequence.length).toBe(2686);
    expect(parsed.sequence.sequence).toBe(canonical.sequence.sequence);
    expect(parsed.sequence.annotations).toHaveLength(13);
    expect(
      primerBinds.map(({ name, start, end, direction }) => [name, start, end, direction])
    ).toEqual([
      ['Synthetic forward 1', 51, 70, 1],
      ['Synthetic forward 2', 251, 270, 1],
      ['Synthetic forward 3', 501, 520, 1],
      ['Synthetic forward 4', 751, 770, 1],
      ['Synthetic forward 5', 1001, 1020, 1],
      ['Synthetic forward 6', 1251, 1270, 1],
      ['Synthetic reverse 1', 1501, 1520, -1],
      ['Synthetic reverse 2', 1701, 1720, -1],
      ['Synthetic reverse 3', 1901, 1920, -1],
      ['Synthetic reverse 4', 2101, 2120, -1],
      ['Synthetic reverse 5', 2301, 2320, -1],
      ['Synthetic reverse 6', 2501, 2520, -1],
    ]);
    expect(parsed.sequence.annotations.find((ann) => ann.type === 'rep_origin')).toMatchObject({
      name: 'Synthetic wrapped origin',
      start: 2315,
      end: 217,
      direction: 0,
      segments: [
        { start: 2315, end: 2686 },
        { start: 1, end: 217 },
      ],
    });
  });

  it('decodes public SnapGene .dna fixtures as annotated sequence entities', () => {
    const fixtureRelativePath = 'test-fixtures/sequences/snapgene/sample-f.dna';
    const fixturePath =
      [
        resolve(process.cwd(), fixtureRelativePath),
        resolve(process.cwd(), '../..', fixtureRelativePath),
      ].find((candidate) => existsSync(candidate)) ?? fixtureRelativePath;
    const bytes = readFileSync(fixturePath);

    const parsed = parseBinarySequenceFileAsAnnotated(bytes, '/project/root/sample-f.dna');
    const annotationsByName = new Map(parsed.sequence.annotations.map((ann) => [ann.name, ann]));

    expect(parsed.format).toBe('snapgene');
    expect(parsed.sequence.name).toBe('Sample');
    expect(parsed.sequence.description).toBe('Sample Sequence F');
    expect(parsed.sequence.circular).toBe(true);
    expect(parsed.sequence.length).toBe(1000);
    expect(parsed.sequence.annotations).toHaveLength(3);
    expect(annotationsByName.get('FeatureB')).toMatchObject({
      type: 'terminator',
      start: 400,
      end: 724,
      direction: -1,
    });
    expect(annotationsByName.get('FeatureA')).toMatchObject({
      type: 'rep_origin',
      start: 161,
      end: 241,
      direction: 1,
    });
    expect(annotationsByName.get('Primer 1')).toMatchObject({
      type: 'primer_bind',
      start: 752,
      end: 776,
      direction: 1,
    });
  });
});
