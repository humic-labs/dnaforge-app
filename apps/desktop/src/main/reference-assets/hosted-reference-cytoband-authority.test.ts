import { describe, expect, it } from 'vitest';

import { projectGenomeAssemblyToRendererAssembly } from '../../features/sequence/components/renderer-assembly-projection';
import { buildGenomeAssembly } from '../../features/sequence/reference-catalog';
import { hostedReferenceShellEntryV1 } from './hosted-reference-asset-authority';
import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';

describe('hosted reference cytoband authority', () => {
  it('derives the sacCer3 ideogram roster and lengths from sacCer3 without human cytoband links', () => {
    const definition = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'sacCer3');
    expect(definition).toBeDefined();

    const shell = hostedReferenceShellEntryV1(definition!);
    expect(
      shell.members.map(({ chrom, displayName, lengthBp }) => ({
        chrom,
        displayName,
        lengthBp,
      }))
    ).toEqual(
      definition!.contigs.map(({ chrom, displayName, lengthBp }) => ({
        chrom,
        displayName,
        lengthBp,
      }))
    );
    expect(shell.members).toHaveLength(17);
    expect(shell.members.reduce((total, member) => total + (member.lengthBp ?? 0), 0)).toBe(
      12_157_105
    );
    expect(shell.members.every((member) => member.cytobandId === undefined)).toBe(true);
    expect(shell.members.filter(({ morphology }) => morphology?.kind === 'localized')).toHaveLength(
      16
    );
  });

  it('links GRCh38 bands explicitly instead of inferring them from chromosome names', () => {
    const definition = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'grch38');
    expect(definition).toBeDefined();

    const shell = hostedReferenceShellEntryV1(definition!);
    expect(shell.members).toHaveLength(24);
    expect(shell.members.every((member) => member.cytobandId === member.chrom)).toBe(true);

    const rendererAssembly = projectGenomeAssemblyToRendererAssembly(
      buildGenomeAssembly(shell, (path) => `/reference-cache/grch38/${path}`)
    );
    expect(rendererAssembly.chromosomes).toHaveLength(24);
    expect(
      rendererAssembly.chromosomes.every(({ chromosome }) => chromosome.cytobands.length > 0)
    ).toBe(true);
    expect(
      rendererAssembly.chromosomes.every(
        ({ chromosome }) => chromosome.morphology?.kind === 'localized'
      )
    ).toBe(true);
  });

  it('carries matured mm39 morphology through the runtime projection boundary', () => {
    const definition = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'mm39');
    expect(definition).toBeDefined();

    const shell = hostedReferenceShellEntryV1(definition!);

    const rendererAssembly = projectGenomeAssemblyToRendererAssembly(
      buildGenomeAssembly(shell, (path) => `/reference-cache/mm39/${path}`)
    );
    const renderedChrY = rendererAssembly.chromosomes.find(
      ({ chromosome }) => chromosome.id === 'chrY'
    );
    const renderedMitochondrion = rendererAssembly.chromosomes.find(
      ({ chromosome }) => chromosome.id === 'chrM'
    );

    expect(renderedChrY?.chromosome.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 4_072_166, endBp: 4_161_965 },
      topology: 'internal',
    });
    expect(renderedMitochondrion?.chromosome.morphology).toEqual({
      kind: 'generic-contig',
      reason: 'ineligible-member',
    });
  });

  it('carries holocentric C. elegans morphology without a fabricated waist', () => {
    const definition = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'ce11');
    expect(definition).toBeDefined();

    const rendererAssembly = projectGenomeAssemblyToRendererAssembly(
      buildGenomeAssembly(
        hostedReferenceShellEntryV1(definition!),
        (path) => `/reference-cache/ce11/${path}`
      )
    );
    expect(
      rendererAssembly.chromosomes
        .filter(({ chromosome }) => chromosome.id !== 'chrM')
        .every(({ chromosome }) => chromosome.morphology?.kind === 'holocentric')
    ).toBe(true);
  });
});
