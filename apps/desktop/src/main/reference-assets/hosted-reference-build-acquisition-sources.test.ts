// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { HOSTED_REFERENCE_BUILD_ACQUISITION_SOURCES_V1 } from './hosted-reference-build-acquisition-sources';

describe('hosted-reference build acquisition sources', () => {
  it('pins the exact NbKLAB author annotation outside the runtime demand roster', () => {
    expect(HOSTED_REFERENCE_BUILD_ACQUISITION_SOURCES_V1).toEqual([
      {
        contract: 'dnaforge-hosted-reference-external-annotation-source.v1',
        provider: 'figshare',
        assemblyId: 'nibenKlab',
        accession: 'GCA_034376525.1', // gitleaks:allow
        articleId: 25441192,
        articleVersion: 1,
        fileId: 45147526,
        fileName: 'Nb_KLAB.gff3',
        sha256: '9b609c1d7e7937265d63efeb04ac0ca45959b581a3a8d4af1e0b27684bfda886',
        byteLength: 58_536_289,
        publishedDate: '2024-03-20',
        license: 'CC BY 4.0',
        attribution: 'Shin Ah-Young (2024)',
        sourceUrl:
          'https://figshare.com/articles/dataset/Nicotiana_benthamiana_KLAB_NbKLAB_Genome_assembly_and_annotation/25441192',
      },
    ]);
  });
});
