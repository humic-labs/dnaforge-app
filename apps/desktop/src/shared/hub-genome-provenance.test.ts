// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  HUB_GENOME_PROVIDER_ASSEMBLY_HUB,
  HUB_GENOME_PROVIDER_GENARK,
  hubGenomeTrackTargetFromProvenance,
} from './hub-genome-provenance';

describe('hubGenomeTrackTargetFromProvenance', () => {
  it('names the hub and genome for hub-derived references only', () => {
    expect(
      hubGenomeTrackTargetFromProvenance({
        provider: HUB_GENOME_PROVIDER_ASSEMBLY_HUB,
        datasetId: 'sacCer3',
        sourceUrl: ' https://yeast-hub.example.org/hub.txt ',
      })
    ).toEqual({ genomeId: 'sacCer3', hubUrl: 'https://yeast-hub.example.org/hub.txt' });
    expect(
      hubGenomeTrackTargetFromProvenance({
        provider: HUB_GENOME_PROVIDER_GENARK,
        datasetId: 'GCF_000146045.2',
        sourceUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
      })
    ).toEqual({
      genomeId: 'GCF_000146045.2',
      hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
    });
  });

  it('refuses other providers, missing or non-HTTP hub addresses, and unsafe genome names', () => {
    expect(
      hubGenomeTrackTargetFromProvenance({
        provider: 'Local file import',
        datasetId: 'local-abc',
        sourceUrl: 'https://example.org/hub.txt',
      })
    ).toBeUndefined();
    expect(
      hubGenomeTrackTargetFromProvenance({ provider: HUB_GENOME_PROVIDER_GENARK, datasetId: 'x' })
    ).toBeUndefined();
    expect(
      hubGenomeTrackTargetFromProvenance({
        provider: HUB_GENOME_PROVIDER_GENARK,
        datasetId: 'x',
        sourceUrl: 'ftp://hub.example.org/hub.txt',
      })
    ).toBeUndefined();
    expect(
      hubGenomeTrackTargetFromProvenance({
        provider: HUB_GENOME_PROVIDER_ASSEMBLY_HUB,
        datasetId: '../escape',
        sourceUrl: 'https://hub.example.org/hub.txt',
      })
    ).toBeUndefined();
  });
});
