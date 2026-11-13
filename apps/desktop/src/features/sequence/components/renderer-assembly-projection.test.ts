import { describe, expect, it } from 'vitest';

import {
  projectGenomeAssemblyToRendererAssembly,
  resolveRendererAssembly,
} from './renderer-assembly-projection';

describe('projectGenomeAssemblyToRendererAssembly', () => {
  it('projects already-normalized localized morphology without exposing provider vocabulary', () => {
    const projected = projectGenomeAssemblyToRendererAssembly({
      assemblyId: 'grch38',
      displayName: 'GRCh38',
      chromosomes: [
        {
          chrom: 'chr11',
          displayName: 'chr11',
          length: 135_086_622,
          role: 'assembled-molecule',
          circular: false,
          cytobandId: 'chr11',
          morphology: {
            kind: 'localized',
            interval: { startBp: 51_000_000, endBp: 55_700_000 },
            topology: 'internal',
          },
          manifest: {
            chrom: 'chr11',
            fastaPath: '/cache/grch38/chr11.fa',
            faiPath: '/cache/grch38/chr11.fa.fai',
            length: 135_086_622,
          },
        },
      ],
    });

    expect(projected.chromosomes[0].chromosome.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 51_000_000, endBp: 55_700_000 },
      topology: 'internal',
    });
  });

  it('projects localized morphology independently of cytobands', () => {
    const projected = projectGenomeAssemblyToRendererAssembly({
      assemblyId: 'mm39',
      displayName: 'GRCm39',
      chromosomes: [
        {
          chrom: 'chrY',
          displayName: 'Y',
          length: 91_455_967,
          role: 'assembled-molecule',
          circular: false,
          morphology: {
            kind: 'localized',
            interval: { startBp: 4_072_166, endBp: 4_161_965 },
            topology: 'internal',
          },
          manifest: {
            chrom: 'chrY',
            fastaPath: '/cache/mm39/chrY.fa',
            faiPath: '/cache/mm39/chrY.fa.fai',
            gffPath: '/cache/mm39/chrY.gff3.gz',
            tbiPath: '/cache/mm39/chrY.gff3.gz.tbi',
            length: 91_455_967,
          },
        },
      ],
    });

    expect(projected.chromosomes[0].chromosome).toMatchObject({
      cytobands: [],
      morphology: {
        kind: 'localized',
        interval: { startBp: 4_072_166, endBp: 4_161_965 },
        topology: 'internal',
      },
    });
  });

  it.each([
    ['holocentric', { kind: 'holocentric' }],
    ['unlocalized centromere', { kind: 'unlocalized-centromere' }],
    ['split arm', { kind: 'between-members', groupId: 'chr2', side: 'right' }],
  ] as const)('projects %s morphology without a fabricated interval', (_label, morphology) => {
    const projected = projectGenomeAssemblyToRendererAssembly({
      assemblyId: 'semantic-assembly',
      displayName: 'Semantic assembly',
      chromosomes: [
        {
          chrom: 'chrA',
          displayName: 'A',
          length: 1_000,
          role: 'assembled-molecule',
          circular: false,
          morphology,
          manifest: {
            chrom: 'chrA',
            fastaPath: '/cache/chrA.fa',
            faiPath: '/cache/chrA.fa.fai',
            length: 1_000,
          },
        },
      ],
    });

    expect(projected.chromosomes[0].chromosome.morphology).toEqual(morphology);
  });

  it.each([
    ['mitochondrial', 'mitochondrion', true],
    ['unordered', 'unplaced-scaffold', false],
  ] as const)(
    'keeps %s members generic even when centromere-like metadata exists',
    (_label, role, circular) => {
      const projected = projectGenomeAssemblyToRendererAssembly({
        assemblyId: 'mm39',
        displayName: 'Fallback assembly',
        chromosomes: [
          {
            chrom: 'chrY',
            displayName: 'Y',
            length: 91_455_967,
            role,
            circular,
            morphology: {
              kind: 'localized',
              interval: { startBp: 4_072_166, endBp: 4_161_965 },
              topology: 'internal',
            },
            manifest: {
              chrom: 'chrY',
              fastaPath: '/cache/mm39/chrY.fa',
              faiPath: '/cache/mm39/chrY.fa.fai',
              length: 91_455_967,
            },
          },
        ],
      });

      expect(projected.chromosomes[0].chromosome.morphology).toEqual({
        kind: 'generic-contig',
        reason: 'ineligible-member',
      });
    }
  );

  it('keeps arbitrary imported sequence identities without requiring cytoband registration', () => {
    const projected = projectGenomeAssemblyToRendererAssembly({
      assemblyId: 'local-content-addressed-reference',
      displayName: 'pUC19',
      chromosomes: [
        {
          chrom: 'puc19',
          displayName: 'pUC19',
          length: 2_686,
          manifest: {
            chrom: 'puc19',
            fastaPath: '/cache/puc19.fa',
            faiPath: '/cache/puc19.fa.fai',
            gffPath: '/cache/puc19.gff3.gz',
            tbiPath: '/cache/puc19.gff3.gz.tbi',
            length: 2_686,
          },
        },
      ],
    });

    expect(projected).toMatchObject({
      id: 'local-content-addressed-reference',
      displayName: 'pUC19',
      totalLengthBp: 2_686,
      chromosomes: [
        {
          chromosome: {
            id: 'puc19',
            displayName: 'pUC19',
            length: 2_686,
            cytobands: [],
            morphology: { kind: 'generic-contig', reason: 'missing-semantics' },
          },
          globalStartBp: 0,
          globalEndBp: 2_686,
          order: 0,
        },
      ],
    });
  });

  it('preserves an admitted zero-width centromere boundary for the renderer', () => {
    const projected = projectGenomeAssemblyToRendererAssembly({
      assemblyId: 'exact-ideogram-reference',
      displayName: 'Exact ideogram reference',
      chromosomes: [
        {
          chrom: 'chr1',
          displayName: '1',
          length: 1_000,
          role: 'assembled-molecule',
          circular: false,
          morphology: {
            kind: 'localized-boundary',
            positionBp: 300,
            topology: 'internal',
          },
          manifest: {
            chrom: 'chr1',
            fastaPath: '/cache/exact/chr1.fa',
            faiPath: '/cache/exact/chr1.fa.fai',
            length: 1_000,
          },
        },
      ],
    });

    expect(projected.chromosomes[0].chromosome.morphology).toEqual({
      kind: 'localized-boundary',
      positionBp: 300,
      topology: 'internal',
    });
  });

  it('uses the admitted reference roster and lengths when chromosome names overlap GRCh38', () => {
    const resolved = resolveRendererAssembly(['chr1'], {
      assemblyId: 'custom-reference',
      displayName: 'Custom reference fixture',
      chromosomes: [
        {
          chrom: 'chr1',
          displayName: 'Chromosome 1',
          length: 12_345,
          manifest: {
            chrom: 'chr1',
            fastaPath: '/cache/non-human/chr1.fa',
            faiPath: '/cache/non-human/chr1.fa.fai',
            gffPath: '/cache/non-human/chr1.gff3.gz',
            tbiPath: '/cache/non-human/chr1.gff3.gz.tbi',
            length: 12_345,
          },
        },
      ],
    });

    expect(resolved).toMatchObject({
      id: 'custom-reference',
      totalLengthBp: 12_345,
      chromosomes: [
        {
          chromosome: {
            id: 'chr1',
            length: 12_345,
            cytobands: [],
          },
        },
      ],
    });
  });

  it('rejects cytobands whose registered sequence length does not match the admitted member', () => {
    const resolved = resolveRendererAssembly(['chrX'], {
      assemblyId: 'sacCer3-fragment',
      displayName: 'Yeast chromosome X',
      chromosomes: [
        {
          chrom: 'chrX',
          displayName: 'X',
          length: 745_751,
          cytobandId: 'chrX',
          manifest: {
            chrom: 'chrX',
            fastaPath: '/cache/sacCer3/chrX.fa',
            faiPath: '/cache/sacCer3/chrX.fa.fai',
            gffPath: '/cache/sacCer3/chrX.gff3.gz',
            tbiPath: '/cache/sacCer3/chrX.gff3.gz.tbi',
            length: 745_751,
          },
        },
      ],
    });

    expect(resolved?.totalLengthBp).toBe(745_751);
    expect(resolved?.chromosomes[0].chromosome.cytobands).toEqual([]);
  });
});
