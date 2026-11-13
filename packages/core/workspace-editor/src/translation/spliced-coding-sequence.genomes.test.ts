import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { buildSplicedCodingSequence } from './spliced-coding-sequence';
import type { Annotation } from '@waypoint/sequence-utils';

const REPO_ROOT = join(__dirname, '../../../../..');
const W3110 = join(REPO_ROOT, 'test-fixtures/genomes/ecoli-W3110/NC_007779.1.gb');
const BSUB = join(
  REPO_ROOT,
  'apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/genomes/bacillus-subtilis-168.gb'
);

function splicedCdsFeatures(gbPath: string): { annotations: Annotation[]; sequence: string } {
  const parsed = parseGenBankFull(readFileSync(gbPath, 'utf-8'));
  return {
    annotations: parsed.annotations.filter(
      (a) => a.type === 'CDS' && a.segments !== undefined && a.segments.length > 1
    ),
    sequence: parsed.sequence,
  };
}

describe('buildSplicedCodingSequence — real genomes  Slice 3a)', () => {
  it('reports ZERO introns across every slippage join in E. coli W3110', () => {
    const { annotations, sequence } = splicedCdsFeatures(W3110);

    expect(annotations.length).toBeGreaterThanOrEqual(23);

    const offenders: string[] = [];
    for (const annotation of annotations) {
      const { introns } = buildSplicedCodingSequence(annotation, sequence);
      if (introns.length > 0) {
        offenders.push(`${annotation.name}: ${introns.map((i) => i.length).join(',')} bp`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never reports an intron larger than its own CDS footprint, genome-wide', () => {
    const { annotations, sequence } = splicedCdsFeatures(W3110);

    for (const annotation of annotations) {
      const { introns } = buildSplicedCodingSequence(annotation, sequence);
      const footprint = annotation.end - annotation.start + 1;
      for (const intron of introns) {
        expect(intron.length).toBeLessThan(footprint);
      }
    }
  });

  it('STILL finds the real 808 bp group I intron in B. subtilis nrdFB (the control)', () => {
    if (!existsSync(BSUB)) return;
    const { annotations, sequence } = splicedCdsFeatures(BSUB);

    const nrdFB = annotations.find((a) => /nrdFB/i.test(a.name));
    expect(nrdFB, 'nrdFB spliced CDS not found').toBeDefined();

    const { introns } = buildSplicedCodingSequence(nrdFB!, sequence);

    expect(introns).toHaveLength(1);
    expect(introns[0].length).toBe(808);
  });

  it('STILL finds the real 252 bp group I intron in B. subtilis nrdEB', () => {
    if (!existsSync(BSUB)) return;
    const { annotations, sequence } = splicedCdsFeatures(BSUB);

    const nrdEB = annotations.find((a) => /nrdEB/i.test(a.name));
    expect(nrdEB, 'nrdEB spliced CDS not found').toBeDefined();

    const { introns } = buildSplicedCodingSequence(nrdEB!, sequence);

    expect(introns).toHaveLength(1);
    expect(introns[0].length).toBe(252);
  });

  it('suppresses the +1 frameshift in B. subtilis prfB while keeping the nrd introns', () => {
    if (!existsSync(BSUB)) return;
    const { annotations, sequence } = splicedCdsFeatures(BSUB);

    const byName = (re: RegExp) => annotations.find((a) => re.test(a.name));
    const counts = {
      prfB: buildSplicedCodingSequence(byName(/prfB/i)!, sequence).introns.length,
      nrdEB: buildSplicedCodingSequence(byName(/nrdEB/i)!, sequence).introns.length,
      nrdFB: buildSplicedCodingSequence(byName(/nrdFB/i)!, sequence).introns.length,
    };

    expect(counts).toEqual({ prfB: 0, nrdEB: 1, nrdFB: 1 });
  });
});
