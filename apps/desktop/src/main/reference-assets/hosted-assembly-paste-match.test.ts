// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { hostedCatalogIdForAssemblyPaste, ucscDatabaseToken } from './hosted-assembly-paste-match';

describe('hosted assembly paste reconciliation', () => {
  it('uses the hosted human genome for an accession, a GenArk page, and hg38', () => {
    expect(hostedCatalogIdForAssemblyPaste('GCF_000001405.40')).toBe('grch38');
    expect(hostedCatalogIdForAssemblyPaste('https://genome.ucsc.edu/h/GCF_000001405.40')).toBe(
      'grch38'
    );
    expect(
      hostedCatalogIdForAssemblyPaste('https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38')
    ).toBe('grch38');
    expect(hostedCatalogIdForAssemblyPaste('hg38')).toBe('grch38');
  });

  it('uses the hosted catalog id for a UCSC database name and an NCBI page', () => {
    expect(hostedCatalogIdForAssemblyPaste('mm39')).toBe('mm39');
    expect(
      hostedCatalogIdForAssemblyPaste(
        'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000005845.2/'
      )
    ).toBe('ecoliK12Mg1655');
    expect(
      hostedCatalogIdForAssemblyPaste('https://www.ebi.ac.uk/ena/browser/view/GCF_000006765.1')
    ).toBe('paeruginosaPao1');
  });

  it('does not claim an assembly that is not hosted', () => {
    expect(hostedCatalogIdForAssemblyPaste('GCF_000008865.2')).toBeNull();
    expect(hostedCatalogIdForAssemblyPaste('https://genome.ucsc.edu/h/GCF_000008865.2')).toBeNull();
    expect(ucscDatabaseToken('notARealGenome')).toBe('notARealGenome');
    expect(hostedCatalogIdForAssemblyPaste('notARealGenome')).toBeNull();
  });
});
