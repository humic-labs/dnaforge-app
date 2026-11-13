import { describe, expect, it } from 'vitest';

import { HOSTED_REFERENCE_BUILD_CATALOG_V1 } from './hosted-reference-build-catalog';
import {
  DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL,
  HOSTED_REFERENCE_CATALOG_V1,
  hostedReferenceCatalogEntryV1,
} from './hosted-reference-catalog';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 } from './hosted-reference-rollout-source-catalog';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_V1 } from './hosted-reference-rollout-source-catalog-public-data';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1 } from './hosted-reference-rollout-source-catalog-public-data-niben';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_WAVE05_V1 } from './hosted-reference-rollout-source-catalog-wave05';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE01_V1 } from './hosted-reference-rollout-source-catalog-public-data-wave01';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_BACTERIA_V1 } from './hosted-reference-rollout-source-catalog-public-data-bacteria';

describe('hosted reference catalog', () => {
  it('pins the active wave source projection to the full build authority', () => {
    const fullSourceById = new Map<
      string,
      (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1)[number]
    >(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1.map((definition) => [definition.id, definition]));

    expect(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_WAVE05_V1.map(({ id }) => id)).toEqual([
      'hs1',
      'rn8',
      'rn7',
      'danRer11',
      'pombeAsm294v3',
      'xenLae10',
      'grcg7b',
      'canFam4',
    ]);
    expect(
      HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_WAVE05_V1.map(({ id }) => fullSourceById.get(id))
    ).toEqual(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_WAVE05_V1);

    expect(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE01_V1.map(({ id }) => id)).toEqual([
      'hg19',
      'mm10',
      'susScrHxylV2',
      'arsUcd2',
      'criGriPicrh1',
      'panTro6',
      'medakaHdRr31',
      'grcz12ab',
    ]);
    for (const definition of HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE01_V1) {
      const prior = fullSourceById.get(definition.id);
      if (prior) expect(definition).toEqual(prior);
    }

    expect(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_V1.map(({ id }) => id)).toEqual([
      'medakaHdRr31',
      'galGal6',
      'canFam6',
      'susScr11',
      'bosTau9',
      'saureusUsa300Fpr3757',
      'sarsCov2WuhanHu1',
    ]);
    for (const definition of HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_V1) {
      const prior = fullSourceById.get(definition.id);
      if (prior) expect(definition).toEqual(prior);
    }

    expect(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_BACTERIA_V1.map(({ id }) => id)).toEqual(
      [
        'ecoliK12Mg1655',
        'ecoliBl21De3',
        'bacillus168',
        'pputidaKt2440',
        'cglutamicumAtcc13032',
        'scoelicolorA32',
        'mtbH37Rv',
        'paeruginosaPao1',
        'saureusNctc8325',
        'salmonellaLt2',
        'saureusUsa300Fpr3757',
      ]
    );
    for (const definition of HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_BACTERIA_V1) {
      const prior = fullSourceById.get(definition.id);
      if (prior) expect(definition).toEqual(prior);
    }

    expect(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1.map(({ id }) => id)).toEqual([
      'nibenKlab',
    ]);
    expect(HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1[0]).toMatchObject({
      provenance: {
        provider: 'NCBI GenBank + Figshare',
        datasetId: 'GCA_034376525.1; 10.6084/m9.figshare.25441192.v1',
        datasetVersion: 'ASM3437652v1; v1',
      },
    });
  });

  it('pins production GRCh38 to immutable admitted sources and the 24 primary chromosomes', () => {
    expect(DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL).toBe(
      'https://references.dnaforge.com/reference-genomes/v1/'
    );
    expect(HOSTED_REFERENCE_CATALOG_V1.map(({ id }) => id)).toEqual([
      'grch38',
      'sacCer3',
      'ce11',
      'mm39',
      'grcz12tu',
      'dm6',
      'xenTro10',
      'tair10',
      'agis1',
      'zmB73v5',
      't2tMmu8v2',
      'rheMac10',
      'mPanTro3v21',
      'mGorGor1v21',
      'mOryCun11',
      'oarRambouilletV3',
      'equCabTbT2t',
      'hs1',
      'rn8',
      'rn7',
      'danRer11',
      'pombeAsm294v3',
      'xenLae10',
      'grcg7b',
      'canFam4',
      'hg19',
      'mm10',
      'susScrHxylV2',
      'arsUcd2',
      'criGriPicrh1',
      'panTro6',
      'medakaHdRr31',
      'grcz12ab',
      'galGal6',
      'canFam6',
      'canFam3',
      'susScr11',
      'bosTau9',
      'pomBase',
      'tomatoSlmR21',
      'irgsp1',
      'soybeanV4',
      'ntK326',
      'kphaffiiGs115',
      'kphaffiiCbs7435',
      'candidaSC5314',
      'anidulansFgscA4',
      'pfalciparum3d7',
      'agambiaeF1',
      'sarsCov2WuhanHu1',
      't2tMfa8v11',
      'sbicolorNcbiv3',
      'wheatRefseqV21',
      'ecoliK12Mg1655',
      'ecoliBl21De3',
      'bacillus168',
      'pputidaKt2440',
      'cglutamicumAtcc13032',
      'scoelicolorA32',
      'mtbH37Rv',
      'paeruginosaPao1',
      'saureusNctc8325',
      'salmonellaLt2',
      'saureusUsa300Fpr3757',
      'nibenKlab',
    ]);
    expect(HOSTED_REFERENCE_BUILD_CATALOG_V1.map(({ id }) => id)).toEqual([
      'grch38',
      'sacCer3',
      'ce11',
      'mm39',
      'grcz12tu',
      'dm6',
      'xenTro10',
      'tair10',
      'agis1',
      'zmB73v5',
      't2tMmu8v2',
      'rheMac10',
      'mPanTro3v21',
      'mGorGor1v21',
      'mOryCun11',
      'oarRambouilletV3',
      'equCabTbT2t',
      'hs1',
      'hg19',
      'mm10',
      'rn8',
      'rn7',
      'danRer11',
      'pombeAsm294v3',
      'xenLae10',
      'grcg7b',
      'canFam4',
      'susScrHxylV2',
      'arsUcd2',
      'criGriPicrh1',
      'panTro6',
      'grcz12ab',
      'canFam3',
      'pomBase',
      'irgsp1',
      'ntK326',
      'tomatoSlmR21',
      'soybeanV4',
      'wheatRefseqV21',
      'ecoliK12Mg1655',
      'ecoliBl21De3',
      'bacillus168',
      'pputidaKt2440',
      'cglutamicumAtcc13032',
      'scoelicolorA32',
      'kphaffiiGs115',
      'kphaffiiCbs7435',
      'candidaSC5314',
      'anidulansFgscA4',
      'mtbH37Rv',
      'paeruginosaPao1',
      'saureusNctc8325',
      'salmonellaLt2',
      'pfalciparum3d7',
      'agambiaeF1',
      'medakaHdRr31',
      'galGal6',
      'canFam6',
      'susScr11',
      'bosTau9',
      'saureusUsa300Fpr3757',
      'sarsCov2WuhanHu1',
      't2tMfa8v11',
      'sbicolorNcbiv3',
      'nibenKlab',
    ]);
    expect(
      HOSTED_REFERENCE_CATALOG_V1.every(({ preparedBundle }) => preparedBundle !== undefined)
    ).toBe(true);
    const preparedBuild = HOSTED_REFERENCE_BUILD_CATALOG_V1.filter(
      ({ preparedBundle }) => preparedBundle !== undefined
    );
    expect(preparedBuild).toHaveLength(HOSTED_REFERENCE_CATALOG_V1.length);
    expect(new Set(preparedBuild.map(({ id }) => id))).toEqual(
      new Set(HOSTED_REFERENCE_CATALOG_V1.map(({ id }) => id))
    );
    for (const entry of HOSTED_REFERENCE_CATALOG_V1) {
      expect(preparedBuild.find(({ id }) => id === entry.id)).toBe(entry);
    }
    expect(
      HOSTED_REFERENCE_CATALOG_V1.map(
        ({ id, preparedBundle }) => [id, preparedBundle?.legacyLayerIdentityContract] as const
      )
    ).toEqual([
      ['grch38', undefined],
      ['sacCer3', undefined],
      ['ce11', undefined],
      ['mm39', undefined],
      ['grcz12tu', undefined],
      ['dm6', undefined],
      ['xenTro10', undefined],
      ['tair10', undefined],
      ['agis1', undefined],
      ['zmB73v5', undefined],
      ['t2tMmu8v2', undefined],
      ['rheMac10', undefined],
      ['mPanTro3v21', undefined],
      ['mGorGor1v21', undefined],
      ['mOryCun11', undefined],
      ['oarRambouilletV3', undefined],
      ['equCabTbT2t', undefined],
      ['hs1', undefined],
      ['rn8', undefined],
      ['rn7', undefined],
      ['danRer11', undefined],
      ['pombeAsm294v3', undefined],
      ['xenLae10', undefined],
      ['grcg7b', undefined],
      ['canFam4', undefined],
      ['hg19', undefined],
      ['mm10', undefined],
      ['susScrHxylV2', undefined],
      ['arsUcd2', undefined],
      ['criGriPicrh1', undefined],
      ['panTro6', undefined],
      ['medakaHdRr31', undefined],
      ['grcz12ab', undefined],
      ['galGal6', undefined],
      ['canFam6', undefined],
      ['canFam3', undefined],
      ['susScr11', undefined],
      ['bosTau9', undefined],
      ['pomBase', undefined],
      ['tomatoSlmR21', undefined],
      ['irgsp1', undefined],
      ['soybeanV4', undefined],
      ['ntK326', undefined],
      ['kphaffiiGs115', undefined],
      ['kphaffiiCbs7435', undefined],
      ['candidaSC5314', undefined],
      ['anidulansFgscA4', undefined],
      ['pfalciparum3d7', undefined],
      ['agambiaeF1', undefined],
      ['sarsCov2WuhanHu1', undefined],
      ['t2tMfa8v11', undefined],
      ['sbicolorNcbiv3', undefined],
      ['wheatRefseqV21', undefined],
      ['ecoliK12Mg1655', undefined],
      ['ecoliBl21De3', undefined],
      ['bacillus168', undefined],
      ['pputidaKt2440', undefined],
      ['cglutamicumAtcc13032', undefined],
      ['scoelicolorA32', undefined],
      ['mtbH37Rv', undefined],
      ['paeruginosaPao1', undefined],
      ['saureusNctc8325', undefined],
      ['salmonellaLt2', undefined],
      ['saureusUsa300Fpr3757', undefined],
      ['nibenKlab', undefined],
    ]);
    expect(
      HOSTED_REFERENCE_BUILD_CATALOG_V1.filter(({ preparedBundle }) => !preparedBundle).every(
        ({ preparedBundle }) => preparedBundle?.legacyLayerIdentityContract === undefined
      )
    ).toBe(true);
    const grch38 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'grch38')!;
    expect(grch38).toMatchObject({
      id: 'grch38',
      name: 'GRCh38 (human)',
      organism: 'Homo sapiens',
      taxId: 9_606,
      assembly: 'GRCh38.p14',
      sources: {
        fasta: {
          relativePath:
            'grch38/GCF_000001405.40/c798efbf2cb51c6d/GRCh38.p14.primary-assembly.fa.gz',
          sha256: 'c798efbf2cb51c6d01b6a759e6c3cf5b48d3b58b95f7ea2fcd0f3e03cde5ae61',
          byteLength: 934_116_592,
        },
        annotations: {
          relativePath:
            'grch38/GCF_000001405.40/6f6da659257e9573/GRCh38.p14.primary-assembly.gff3.gz',
          sha256: '6f6da659257e957387360de699ee3f45206ada3edd5fc233399773fc98db7d16',
          byteLength: 101_588_741,
        },
      },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/67/67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
          sha256: '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
          byteLength: 524703,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
          bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
          tiers: ['detail', 'search'],
          rosterSha256: 'ac410258243c5a584b4e3466d14465d7e96028b5e2a89979d4d4862b59b6f5b2',
          memberCount: 441,
          individualObjectIds: [
            'chr1-fasta',
            'chr10-fasta',
            'chr11-fasta',
            'chr12-fasta',
            'chr2-fasta',
            'chr3-fasta',
            'chr4-fasta',
            'chr5-fasta',
            'chr6-fasta',
            'chr7-fasta',
            'chr8-fasta',
            'chr9-fasta',
            'chrX-fasta',
            'scene-payload-light-67fdb9926f2ae5c67f80',
            'scene-payload-light-99f6bdabec3df26b65a1',
            'scene-payload-light-b836054b8c6c9a55dfea',
            'scene-payload-light-d5691a1b86a4c7d43143',
            'annotation-search-payload',
            'protein-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/14/1485902914c842bc2856819e7c1a0066255d51ac8a1c145dd519c6c2e61de582',
              sha256: '1485902914c842bc2856819e7c1a0066255d51ac8a1c145dd519c6c2e61de582',
              byteLength: 509778,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 0,
              shardCount: 38,
              rosterSha256: '55951d6b4c4bfa5b11c8f0fac67d1d21e8f71cac7ce718cc3a23e59fbeddd944',
              memberCount: 147,
              uncompressedByteLength: 5962667,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/0f/0f9953125fae53a95bd07295feaf5ae2cd4a06d1ea652285d82bf2d6fc44ef73',
              sha256: '0f9953125fae53a95bd07295feaf5ae2cd4a06d1ea652285d82bf2d6fc44ef73',
              byteLength: 1793071,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 1,
              shardCount: 38,
              rosterSha256: '4f182ddab92f79b1ea31e8cc721809fe8181fb6033fc3b8e5331ab9696ed5cdf',
              memberCount: 1,
              uncompressedByteLength: 31049742,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/7e/7e79882ce7b84a378b2903444a494d09d4d1ec4ff990305f4266de78864abb45',
              sha256: '7e79882ce7b84a378b2903444a494d09d4d1ec4ff990305f4266de78864abb45',
              byteLength: 10887612,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 2,
              shardCount: 38,
              rosterSha256: 'e9cc21de7a32c9bd70c0f28a74747863f82805f3baa0b14df1a07232c0ed3c75',
              memberCount: 5,
              uncompressedByteLength: 25282235,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/71/71836e75ceaf03d8c035be5b7bef05c202b7cdfd8c100c146a0397ce2eb23251',
              sha256: '71836e75ceaf03d8c035be5b7bef05c202b7cdfd8c100c146a0397ce2eb23251',
              byteLength: 6072521,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 3,
              shardCount: 38,
              rosterSha256: '21edc71900c9daa5d28d6e3b484a0f7743a658653e514df6c107f72e17b4065c',
              memberCount: 5,
              uncompressedByteLength: 22803204,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/c8/c8522e7337af37869f3610baf29b6de9636ebda71150e8afcc259060ab669cf9',
              sha256: 'c8522e7337af37869f3610baf29b6de9636ebda71150e8afcc259060ab669cf9',
              byteLength: 6925798,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 4,
              shardCount: 38,
              rosterSha256: '3b95cd78b3f3194764642cdd7c9ca4db0f9ccdfb3494cfc6d8a7ef352eb73d7e',
              memberCount: 5,
              uncompressedByteLength: 23036481,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ef/ef77b01ee4a690d1d44c76d520c03b15fbe778d0134468ec3f16c35ae5a51a14',
              sha256: 'ef77b01ee4a690d1d44c76d520c03b15fbe778d0134468ec3f16c35ae5a51a14',
              byteLength: 6120390,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 5,
              shardCount: 38,
              rosterSha256: '47e77f3d2a1214d1216ee49a43178c5c2da9b514aeb6aba5348cbf5dc8bb5b16',
              memberCount: 5,
              uncompressedByteLength: 12531185,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/20/2059b1eeb28a87fdb49c9704be993392375d788eb18d635522bd64af8943c219',
              sha256: '2059b1eeb28a87fdb49c9704be993392375d788eb18d635522bd64af8943c219',
              byteLength: 30765100,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 6,
              shardCount: 38,
              rosterSha256: '0e4b9ba9aa7f19b514f3490a87d080260f0c7c9267c2a1d9194c80a11fad0d6d',
              memberCount: 3,
              uncompressedByteLength: 30895964,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/49/49705a2596f9e39c93a1446e9d7110a7c4d248a0c4605848b0b81eb6115e5fd5',
              sha256: '49705a2596f9e39c93a1446e9d7110a7c4d248a0c4605848b0b81eb6115e5fd5',
              byteLength: 2775277,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 7,
              shardCount: 38,
              rosterSha256: 'b36901a3e3e11426c2e6ccde1b319a1ce9e8399654a59c8bb765d7a90a901897',
              memberCount: 3,
              uncompressedByteLength: 12376910,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/75/75f48a19e6c1986cc0ea04fc77a6978a81d1e342dcd0f09e5ae5139b3006da2d',
              sha256: '75f48a19e6c1986cc0ea04fc77a6978a81d1e342dcd0f09e5ae5139b3006da2d',
              byteLength: 31635366,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 8,
              shardCount: 38,
              rosterSha256: 'b09631569940e8e7ff64592fed4b97a536cf187fa523e3b8131398d0f9576aa7',
              memberCount: 5,
              uncompressedByteLength: 31769766,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/aa/aa0a45867788fba35f7da858f7fb1878e8cbc9b3eca638cf1eb05e6cf23b3361',
              sha256: 'aa0a45867788fba35f7da858f7fb1878e8cbc9b3eca638cf1eb05e6cf23b3361',
              byteLength: 628060,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 9,
              shardCount: 38,
              rosterSha256: '1ec151f5a348653a8e46a798d3b10099eb082b3c58823b82bcb2d46f4d599e5c',
              memberCount: 1,
              uncompressedByteLength: 11037311,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/85/85fbfd146bd2b231b2bffb61d3f75cbd80c029e4b6d646aba102477b90243c76',
              sha256: '85fbfd146bd2b231b2bffb61d3f75cbd80c029e4b6d646aba102477b90243c76',
              byteLength: 30029263,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 10,
              shardCount: 38,
              rosterSha256: '067dcee680d4459fa29d542fb1dc0b7e1ee6e32a0ebce38aafbde2f66f2b442c',
              memberCount: 5,
              uncompressedByteLength: 30211720,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/99/9917ad26eede969b9177bab1b62c159097d3a36a1d2712e9536e54f7d09bb5f5',
              sha256: '9917ad26eede969b9177bab1b62c159097d3a36a1d2712e9536e54f7d09bb5f5',
              byteLength: 745021,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 11,
              shardCount: 38,
              rosterSha256: 'afe0310aab2a6d90fddfb043fa74af422bac83cf040988119ff2692df1a2effe',
              memberCount: 1,
              uncompressedByteLength: 12467119,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/63/630f453f6ff229903b6e2d4d7714cccb09cf7531af8ebb1987f72c6f24598a95',
              sha256: '630f453f6ff229903b6e2d4d7714cccb09cf7531af8ebb1987f72c6f24598a95',
              byteLength: 29486860,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 12,
              shardCount: 38,
              rosterSha256: '854d98fa06f4290d3b68d52c154709dae4ae69c97ef8bd0ad506924118c39c03',
              memberCount: 5,
              uncompressedByteLength: 29569006,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e5/e5aa6b84dbc0077d948fb96165ec7237dffb12a52e8f0567a1881f01759a955b',
              sha256: 'e5aa6b84dbc0077d948fb96165ec7237dffb12a52e8f0567a1881f01759a955b',
              byteLength: 962993,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 13,
              shardCount: 38,
              rosterSha256: '545500cee9e22a38c0fb8823deb94832aa142bd1c420260f457ff1e11bcb78b4',
              memberCount: 1,
              uncompressedByteLength: 16956599,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/19/199db71699e972db8196cb6abf3d0f7f49097f1a1c73288095b9e3a61dc28c43',
              sha256: '199db71699e972db8196cb6abf3d0f7f49097f1a1c73288095b9e3a61dc28c43',
              byteLength: 31270954,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 14,
              shardCount: 38,
              rosterSha256: 'c1a008e8aa5b746b8ab36d6d7b87b0405ac599bc03c951d11ba85346e3010f58',
              memberCount: 5,
              uncompressedByteLength: 31297891,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/17/171a127617e0af45e9577dc7c543d96d3ca0e28f36eeedccff993d26e68d2420',
              sha256: '171a127617e0af45e9577dc7c543d96d3ca0e28f36eeedccff993d26e68d2420',
              byteLength: 24892062,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 15,
              shardCount: 38,
              rosterSha256: '93bec795d06376a61b4c5234463b8d42261c0ad5c28717f69061449f1b7e0169',
              memberCount: 4,
              uncompressedByteLength: 30790854,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/f0/f06c56ff60fc320045c9ea4a42b298e513a0f8834a84d784eacc56ec08a9d180',
              sha256: 'f06c56ff60fc320045c9ea4a42b298e513a0f8834a84d784eacc56ec08a9d180',
              byteLength: 3077309,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 16,
              shardCount: 38,
              rosterSha256: 'c36edff25cdd1565d3768610a41854f2ee5d9999b11e437e6b0bbc09407485dd',
              memberCount: 3,
              uncompressedByteLength: 16684851,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/99/9926cf90ca33e39c160485f2bfabe66cb1a79c378ee70a1f7e6808e8d5d50957',
              sha256: '9926cf90ca33e39c160485f2bfabe66cb1a79c378ee70a1f7e6808e8d5d50957',
              byteLength: 22508475,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 17,
              shardCount: 38,
              rosterSha256: '34b16c101da856c8f9281793ceb5e6f3fbeb2ded948572e78d2b9fe2a1dd4475',
              memberCount: 5,
              uncompressedByteLength: 22508391,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/25/251a191870a0f5800c79136932eb6753a08086a8893797aefb6dc136c22df02c',
              sha256: '251a191870a0f5800c79136932eb6753a08086a8893797aefb6dc136c22df02c',
              byteLength: 1384162,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 18,
              shardCount: 38,
              rosterSha256: '88ce58291716725eceab9a2735c96e7111ca4555f974b26201b351a31ab89783',
              memberCount: 1,
              uncompressedByteLength: 25840874,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/1c/1c50b20d7d60393d24437aeafab21206933f25e9a0ad5d7486fe633458828cc3',
              sha256: '1c50b20d7d60393d24437aeafab21206933f25e9a0ad5d7486fe633458828cc3',
              byteLength: 8855820,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 19,
              shardCount: 38,
              rosterSha256: '78304725d34ec7e07db3e99f0b865abc0e8b9f22b98bf14413916b797443bcf3',
              memberCount: 5,
              uncompressedByteLength: 16161190,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/63/639102d381a831bc40b96b0a87fe91e82d51dae630e710c5676f91c5bb3d3dbd',
              sha256: '639102d381a831bc40b96b0a87fe91e82d51dae630e710c5676f91c5bb3d3dbd',
              byteLength: 22358477,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 20,
              shardCount: 38,
              rosterSha256: '7133c77c3dac361b787094af5d949e9d3cbe71d08dcde2921072d61994a13dc7',
              memberCount: 6,
              uncompressedByteLength: 25776270,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/7e/7e0f1a622b044f4daf19f2fb571538120a2223844202482ab329bb090174b006',
              sha256: '7e0f1a622b044f4daf19f2fb571538120a2223844202482ab329bb090174b006',
              byteLength: 13929001,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 21,
              shardCount: 38,
              rosterSha256: '3375aa7efcb5462b1d93196c949af637cb5f1e0e10531b9bc61f0d3c454e58be',
              memberCount: 6,
              uncompressedByteLength: 20579200,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ff/ffbfd8646875e0f700d20bc8418ac9e35eb05ea32a45dac27a6562cad12c447a',
              sha256: 'ffbfd8646875e0f700d20bc8418ac9e35eb05ea32a45dac27a6562cad12c447a',
              byteLength: 14288481,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 22,
              shardCount: 38,
              rosterSha256: '5495e83e5f17cdc844e66b2cb89f7d8bb5750d308b058e5fdcca15e8f952f660',
              memberCount: 5,
              uncompressedByteLength: 14372762,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e8/e8ad745586d820c734c8ec1b4bf601d0029ab6173b70c8d37535ff95998d1778',
              sha256: 'e8ad745586d820c734c8ec1b4bf601d0029ab6173b70c8d37535ff95998d1778',
              byteLength: 1095057,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 23,
              shardCount: 38,
              rosterSha256: '449801222de1776d34248be6c9bab35aebd18c4de94b66d4a906737e0d64d5ee',
              memberCount: 1,
              uncompressedByteLength: 20248628,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/86/8682c18daa7ada66307aa07ead863d1a7bafab132acb1f6231c64ea55fdea345',
              sha256: '8682c18daa7ada66307aa07ead863d1a7bafab132acb1f6231c64ea55fdea345',
              byteLength: 7715147,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 24,
              shardCount: 38,
              rosterSha256: '317141177d32687e0945316a47253c2b2cc9029885c6e8aba6523b8dfd9ba200',
              memberCount: 5,
              uncompressedByteLength: 20745993,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/96/969495d944d89e460aecd3867ca9e4afc3baf70d65d1eaa47437cd4f32218f12',
              sha256: '969495d944d89e460aecd3867ca9e4afc3baf70d65d1eaa47437cd4f32218f12',
              byteLength: 5511347,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 25,
              shardCount: 38,
              rosterSha256: 'a5a43d3dfb86aed80ab41a535f8507c5b03efd2684d2e3ca0717291753acca3f',
              memberCount: 5,
              uncompressedByteLength: 19315285,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/70/707d8051aee1dfde4a487579aa95e478d341659f1583b79b6804cdc4abb1c805',
              sha256: '707d8051aee1dfde4a487579aa95e478d341659f1583b79b6804cdc4abb1c805',
              byteLength: 5659143,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 26,
              shardCount: 38,
              rosterSha256: 'f339f7c21843381c142baea1a4a1ef7d69aabbc2b53bfc5e87af8bf8e8d5da7a',
              memberCount: 5,
              uncompressedByteLength: 21147907,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/cf/cfa80adebfbb3a2790c0e28bd0db1eb3d5ca5dbb6b357dcaad0e0d9e8b36dcea',
              sha256: 'cfa80adebfbb3a2790c0e28bd0db1eb3d5ca5dbb6b357dcaad0e0d9e8b36dcea',
              byteLength: 6234909,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 27,
              shardCount: 38,
              rosterSha256: 'b15af77c216e15bd52156645cd1d7cb3443b792c310a5647816fefa0798a86c7',
              memberCount: 5,
              uncompressedByteLength: 20773674,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/c3/c318f895d7a09d277117742148833df036f6e0cac0d6d9c2d0a9ca5bf681c51e',
              sha256: 'c318f895d7a09d277117742148833df036f6e0cac0d6d9c2d0a9ca5bf681c51e',
              byteLength: 5644795,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 28,
              shardCount: 38,
              rosterSha256: '6f29a1a7e81c08c086af2c764768de7b278385f6026406d1568e55c7fc8f0b09',
              memberCount: 5,
              uncompressedByteLength: 17665551,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/8c/8cde3466c0ba24f68c116f04ed05f96ccf87506112362060c2872bcdc017ba8b',
              sha256: '8cde3466c0ba24f68c116f04ed05f96ccf87506112362060c2872bcdc017ba8b',
              byteLength: 4982149,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 29,
              shardCount: 38,
              rosterSha256: '313e0f45ba8cb6572675fa675d91e3512e219958e62842e4401c08e42772154f',
              memberCount: 5,
              uncompressedByteLength: 18380446,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/c7/c75645c610790e02c6c17ab5ee6ba772081b0250f5302853cfee2bb516c1a8ab',
              sha256: 'c75645c610790e02c6c17ab5ee6ba772081b0250f5302853cfee2bb516c1a8ab',
              byteLength: 5281091,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 30,
              shardCount: 38,
              rosterSha256: '473b3fb020728926e42d45233f2b1b65638ce115c6d65326d3cbbaa2b9093cab',
              memberCount: 5,
              uncompressedByteLength: 14171740,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/36/366f4ff8bc9e2ae12894004fd876c8c048d9e0480e4351184295e82831210d7b',
              sha256: '366f4ff8bc9e2ae12894004fd876c8c048d9e0480e4351184295e82831210d7b',
              byteLength: 13646676,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 31,
              shardCount: 38,
              rosterSha256: '96d03d8c7db7089cbeed8a561f3835dc78003841c4601612f105003f4815110f',
              memberCount: 70,
              uncompressedByteLength: 29211345,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/46/4617b45c9821150bd005a74fac552fba87f934e9e70ea34dc35321db4284655b',
              sha256: '4617b45c9821150bd005a74fac552fba87f934e9e70ea34dc35321db4284655b',
              byteLength: 2488852,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 32,
              shardCount: 38,
              rosterSha256: '2bbb4765f8accd86609a8fd01bd2b7cd2183a0dddf6e740bbb3ecda2b5ead0e0',
              memberCount: 1,
              uncompressedByteLength: 16023613,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/d7/d7807bd33569a85aedd62a7591c69cb130c5d1094ac6482fe7a465b42be17063',
              sha256: 'd7807bd33569a85aedd62a7591c69cb130c5d1094ac6482fe7a465b42be17063',
              byteLength: 209616,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 33,
              shardCount: 38,
              rosterSha256: '64ed7b757779ee016ada2b4a8fbd973877827ba4f3c66dc0def1b33af750f8fb',
              memberCount: 28,
              uncompressedByteLength: 3289151,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/9e/9e6a5f0edb026c5f892a23f3f3c0e96563fdea49220c71014c040a12cd2826f9',
              sha256: '9e6a5f0edb026c5f892a23f3f3c0e96563fdea49220c71014c040a12cd2826f9',
              byteLength: 5584946,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 34,
              shardCount: 38,
              rosterSha256: '626092682e6cf070e0128a36f51c0cbbd01ceaee136a4bf11f56bbc07fb304d8',
              memberCount: 23,
              uncompressedByteLength: 30569643,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/42/42fde71a046495695c3490d30d9d8f293620668baf93219cf8754a27a1a1ef96',
              sha256: '42fde71a046495695c3490d30d9d8f293620668baf93219cf8754a27a1a1ef96',
              byteLength: 113299,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 35,
              shardCount: 38,
              rosterSha256: '23d7a2de5949dd81ffcc02cbc2e24b338051b5782fddb0a66b628a08326154a9',
              memberCount: 14,
              uncompressedByteLength: 1656848,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e8/e80f7e2cfe4280df3ce71b24398dbbf97a2d8b70fa9ad47ba71ce784967dfd84',
              sha256: 'e80f7e2cfe4280df3ce71b24398dbbf97a2d8b70fa9ad47ba71ce784967dfd84',
              byteLength: 4473283,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 36,
              shardCount: 38,
              rosterSha256: '79e23d8d222395ade05f170123726ae3573870190fd96943cb0f778f716a224f',
              memberCount: 17,
              uncompressedByteLength: 28248589,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/8c/8ce6eaaa2e0b03f090310a9d12d78d06d1209c5d155bd0d3d2f4d4862aa78a3d',
              sha256: '8ce6eaaa2e0b03f090310a9d12d78d06d1209c5d155bd0d3d2f4d4862aa78a3d',
              byteLength: 2128,
              bundleManifestSha256:
                '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
              bundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
              shardIndex: 37,
              shardCount: 38,
              rosterSha256: 'f30e56a12965d8b8ea01d40f8b6658bbd57f3d6b66643662cef0ce1e065eb4e3',
              memberCount: 1,
              uncompressedByteLength: 5776,
            },
          ],
        },
      },
      provenance: {
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_000001405.40',
        datasetVersion: 'GRCh38.p14',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      },
    });
    expect(grch38.contigs.map(({ chrom, lengthBp }) => [chrom, lengthBp])).toEqual([
      ['chr1', 248_956_422],
      ['chr2', 242_193_529],
      ['chr3', 198_295_559],
      ['chr4', 190_214_555],
      ['chr5', 181_538_259],
      ['chr6', 170_805_979],
      ['chr7', 159_345_973],
      ['chr8', 145_138_636],
      ['chr9', 138_394_717],
      ['chr10', 133_797_422],
      ['chr11', 135_086_622],
      ['chr12', 133_275_309],
      ['chr13', 114_364_328],
      ['chr14', 107_043_718],
      ['chr15', 101_991_189],
      ['chr16', 90_338_345],
      ['chr17', 83_257_441],
      ['chr18', 80_373_285],
      ['chr19', 58_617_616],
      ['chr20', 64_444_167],
      ['chr21', 46_709_983],
      ['chr22', 50_818_468],
      ['chrX', 156_040_895],
      ['chrY', 57_227_415],
    ]);
    expect(grch38.contigs.map(({ aliases }) => aliases?.refseq)).toEqual([
      'NC_000001.11',
      'NC_000002.12',
      'NC_000003.12',
      'NC_000004.12',
      'NC_000005.10',
      'NC_000006.12',
      'NC_000007.14',
      'NC_000008.11',
      'NC_000009.12',
      'NC_000010.11',
      'NC_000011.10',
      'NC_000012.12',
      'NC_000013.11',
      'NC_000014.9',
      'NC_000015.10',
      'NC_000016.10',
      'NC_000017.11',
      'NC_000018.10',
      'NC_000019.10',
      'NC_000020.11',
      'NC_000021.9',
      'NC_000022.11',
      'NC_000023.11',
      'NC_000024.10',
    ]);
    expect(
      grch38.contigs.every(
        (contig) =>
          contig.sourceSeqId === contig.chrom &&
          contig.displayName === contig.chrom &&
          contig.role === 'assembled-molecule' &&
          contig.aliases?.ucsc === contig.chrom &&
          contig.aliases?.ensembl === contig.chrom.slice(3) &&
          contig.circular === false
      )
    ).toBe(true);
    expect(grch38.contigs.reduce((sum, contig) => sum + contig.lengthBp, 0)).toBe(3_088_269_832);
    expect(HOSTED_REFERENCE_CATALOG_V1.some((entry) => /puc19/i.test(entry.id))).toBe(false);
  });

  it('pins sacCer3 to its exact NCBI assembly and promoted prepared publication', () => {
    const sacCer3 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'sacCer3');

    expect(sacCer3).toMatchObject({
      name: 'Saccharomyces cerevisiae (sacCer3)',
      organism: 'Saccharomyces cerevisiae S288C',
      taxId: 559_292,
      assembly: 'GCF_000146045.2',
      sources: {
        fasta: {
          relativePath: 'sacCer3/GCF_000146045.2/fe42735d3e6242f/GCF_000146045.2_R64_genomic.fna',
          sha256: 'fe42735d3e6242f8c40b457a232940e34ef15eb4502717e54a34ed118face4c1',
          byteLength: 12_310_392,
        },
        annotations: {
          relativePath: 'sacCer3/GCF_000146045.2/228ea6918fc034e8/genomic.gff',
          sha256: '228ea6918fc034e80a34f87d30729c0a8caeb019861baef7d14878324a0d7b8c',
          byteLength: 12_464_547,
        },
      },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/5f/5f0670dc842c9ea3eabb5836e8d85f8e31a70e8cb83bf31c217ccc7b9cb82686',
          sha256: '5f0670dc842c9ea3eabb5836e8d85f8e31a70e8cb83bf31c217ccc7b9cb82686',
          byteLength: 266711,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/5a/5a0acf68f7fba84fbd0e84c12825469b22ddc711020befc7edfa4d8b97798efe',
          sha256: '5a0acf68f7fba84fbd0e84c12825469b22ddc711020befc7edfa4d8b97798efe',
          byteLength: 586934,
          bundleManifestSha256: '5f0670dc842c9ea3eabb5836e8d85f8e31a70e8cb83bf31c217ccc7b9cb82686',
          bundleFingerprint: '42c7550275b5f626188a030dd26ed65506ad926d52d6e0e1713875ba25a18a5f',
          tiers: ['shell', 'view'],
          rosterSha256: '7cbcf8e15bc6d224ad217b0e976195824f7ed7d034292dca45c2b4547debe9d3',
          memberCount: 212,
          uncompressedByteLength: 4985104,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: '5f0670dc842c9ea3eabb5836e8d85f8e31a70e8cb83bf31c217ccc7b9cb82686',
          bundleFingerprint: '42c7550275b5f626188a030dd26ed65506ad926d52d6e0e1713875ba25a18a5f',
          tiers: ['detail', 'search'],
          rosterSha256: 'bd7fb638b145acbb26baa38bdea9f7cc408e231bc2e9c4da03566aee80d954c6',
          memberCount: 247,
          individualObjectIds: [],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/28/282220957ddcbcb48006f43e540f7f00b4bc4913f21fbad54cfcccbc67150fc6',
              sha256: '282220957ddcbcb48006f43e540f7f00b4bc4913f21fbad54cfcccbc67150fc6',
              byteLength: 10683762,
              bundleManifestSha256:
                '5f0670dc842c9ea3eabb5836e8d85f8e31a70e8cb83bf31c217ccc7b9cb82686',
              bundleFingerprint: '42c7550275b5f626188a030dd26ed65506ad926d52d6e0e1713875ba25a18a5f',
              shardIndex: 0,
              shardCount: 1,
              rosterSha256: 'bd7fb638b145acbb26baa38bdea9f7cc408e231bc2e9c4da03566aee80d954c6',
              memberCount: 247,
              uncompressedByteLength: 27350119,
            },
          ],
        },
      },
    });
    expect(sacCer3?.contigs).toHaveLength(17);
    expect(sacCer3?.contigs.reduce((sum, contig) => sum + contig.lengthBp, 0)).toBe(12_157_105);
    expect(sacCer3?.contigs.at(-1)).toMatchObject({
      chrom: 'chrM',
      sourceSeqId: 'NC_001224.1',
      role: 'mitochondrion',
      circular: true,
    });
  });

  it('pins ce11 to its exact NCBI assembly and promoted prepared publication', () => {
    const ce11 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'ce11');

    expect(ce11).toMatchObject({
      name: 'C. elegans (ce11 / WBcel235)',
      organism: 'Caenorhabditis elegans',
      taxId: 6_239,
      assembly: 'GCF_000002985.6',
      sources: {
        fasta: {
          relativePath:
            'ce11/GCF_000002985.6/739d1fb774ef9f5a/GCF_000002985.6_WBcel235_genomic.fna',
          sha256: '739d1fb774ef9f5a2de12fd16de3e559201d00d69502b7013d820584d9369220',
          byteLength: 101_540_352,
        },
        annotations: {
          relativePath: 'ce11/GCF_000002985.6/b6296b398ce09b94/genomic.gff',
          sha256: 'b6296b398ce09b944696d7519d5013886e3ee2172760a6a6849774afc116334d',
          byteLength: 174_184_304,
        },
      },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/2e/2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
          sha256: '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
          byteLength: 77764,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/a1/a174a80a10f489d8bb81f785bb122f1e30b1f151abed7c0783ad75baf2173de6',
          sha256: 'a174a80a10f489d8bb81f785bb122f1e30b1f151abed7c0783ad75baf2173de6',
          byteLength: 3536885,
          bundleManifestSha256: '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
          bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
          tiers: ['shell', 'view'],
          rosterSha256: '74d5572a4b25d304e78b79d799f886c80464535edc10c8d04b6fa090705dac30',
          memberCount: 56,
          uncompressedByteLength: 19603060,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
          bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
          tiers: ['detail', 'search'],
          rosterSha256: '0fb7306057f2c4b928abf3e01643b2b9b3b1de3939b49f0e9932eba5c253c377',
          memberCount: 83,
          individualObjectIds: [
            'scene-payload-light-453649a62106359a724c',
            'annotation-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/66/66db1f4bc555d3355e18b1bad0a4b14d73636835c0446e1af403fb801cb168db',
              sha256: '66db1f4bc555d3355e18b1bad0a4b14d73636835c0446e1af403fb801cb168db',
              byteLength: 14692925,
              bundleManifestSha256:
                '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
              bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
              shardIndex: 0,
              shardCount: 6,
              rosterSha256: '18b45be2b005f3afb0dcd9d489853aa48a2ba251aff8f96f33d49f64c38c680c',
              memberCount: 32,
              uncompressedByteLength: 30509864,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e6/e6c60bc1a351144901be16701fed1cace527f4df1d3f2b36278b46b84e0241cf',
              sha256: 'e6c60bc1a351144901be16701fed1cace527f4df1d3f2b36278b46b84e0241cf',
              byteLength: 16132202,
              bundleManifestSha256:
                '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
              bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
              shardIndex: 1,
              shardCount: 6,
              rosterSha256: '91e8d47a439a888b2a611e12ecd10ef7a1266150a249ac2afe1c3094c41ec8c3',
              memberCount: 17,
              uncompressedByteLength: 30966276,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/d7/d7f4745ace4d120af84f870fd814d5980c945c0e1f1ecbb679d58d8368bdf29b',
              sha256: 'd7f4745ace4d120af84f870fd814d5980c945c0e1f1ecbb679d58d8368bdf29b',
              byteLength: 16342972,
              bundleManifestSha256:
                '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
              bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
              shardIndex: 2,
              shardCount: 6,
              rosterSha256: '7ddc5565c6f4abf2c22a06501b0860d3e1b70753f7e758d7a445d3dc5090cf60',
              memberCount: 10,
              uncompressedByteLength: 31186016,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/a5/a5f4c91577d23ca265edef3baae3e058312ddbced45b0d83d2241b21fa00fa4b',
              sha256: 'a5f4c91577d23ca265edef3baae3e058312ddbced45b0d83d2241b21fa00fa4b',
              byteLength: 1860673,
              bundleManifestSha256:
                '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
              bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
              shardIndex: 3,
              shardCount: 6,
              rosterSha256: '3c24f83e8bff39e1b4f1761250d34dd09454bbedafce029fbeadad31fd106913',
              memberCount: 3,
              uncompressedByteLength: 1878487,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ed/ed16a2e9e37670127362be5b1cd007df6d49f3c2e52f43de5262ed238a00e6a6',
              sha256: 'ed16a2e9e37670127362be5b1cd007df6d49f3c2e52f43de5262ed238a00e6a6',
              byteLength: 1972376,
              bundleManifestSha256:
                '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
              bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
              shardIndex: 4,
              shardCount: 6,
              rosterSha256: 'fe2cc6f8cf02ed3a8c7760672b5e7401fac6d1b24f2224f1c8e737faef105b0e',
              memberCount: 17,
              uncompressedByteLength: 13762552,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/9b/9be695549640783851cf0958bd4466661054453ce84594796aacd64bfd17370d',
              sha256: '9be695549640783851cf0958bd4466661054453ce84594796aacd64bfd17370d',
              byteLength: 7243316,
              bundleManifestSha256:
                '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
              bundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
              shardIndex: 5,
              shardCount: 6,
              rosterSha256: '897e6641f79295b28ced840786f48cdeaaee40b4a35302ca1b1d1d824b0af7b3',
              memberCount: 2,
              uncompressedByteLength: 28333820,
            },
          ],
        },
      },
      provenance: {
        provider: 'WormBase',
        datasetId: 'GCF_000002985.6',
        datasetVersion: 'WormBase WS298',
      },
    });
    expect(ce11?.contigs).toHaveLength(7);
    expect(ce11?.contigs.reduce((sum, contig) => sum + contig.lengthBp, 0)).toBe(100_286_401);
    expect(
      ce11?.contigs.map(({ chrom, sourceSeqId, displayName }) => [chrom, sourceSeqId, displayName])
    ).toEqual([
      ['chrI', 'NC_003279.8', 'I'],
      ['chrII', 'NC_003280.10', 'II'],
      ['chrIII', 'NC_003281.10', 'III'],
      ['chrIV', 'NC_003282.8', 'IV'],
      ['chrV', 'NC_003283.11', 'V'],
      ['chrX', 'NC_003284.9', 'X'],
      ['chrM', 'NC_001328.1', 'MT'],
    ]);
    expect(ce11?.contigs.at(-1)).toMatchObject({
      aliases: {
        refseq: 'NC_001328.1',
        genbank: 'X54252.1',
        ucsc: 'chrM',
        ensembl: 'MT',
      },
      role: 'mitochondrion',
      circular: true,
    });
  });

  it('pins tair10 to the exact verified prepared publication', () => {
    const tair10 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'tair10');

    expect(tair10).toMatchObject({
      id: 'tair10',
      provenance: {
        datasetId: 'GCF_000001735.4',
      },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/1b/1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
          sha256: '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
          byteLength: 60433,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/17/17faeaa3aee7cd8edc3471af1043a8c52ec15244ffe6d0c184d83a70859dea14',
          sha256: '17faeaa3aee7cd8edc3471af1043a8c52ec15244ffe6d0c184d83a70859dea14',
          byteLength: 3993063,
          bundleManifestSha256: '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
          bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
          tiers: ['shell', 'view'],
          rosterSha256: 'ce17772d442d480a63c34235ad3c2095cfaa65d6992065299c7e78df8b2098f5',
          memberCount: 44,
          uncompressedByteLength: 21107097,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
          bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
          tiers: ['detail', 'search'],
          rosterSha256: 'a1c3d28fa220bcd52d5a8d2e16992d2751142b1b175111fc0cb8953edc1b92d2',
          memberCount: 63,
          individualObjectIds: [
            'scene-payload-light-b591faae81ed9c599b94',
            'annotation-search-payload',
            'protein-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/c6/c698fc128da40924f58de33c43bb0358cb9a4c9c3b67fc2a7db393eb311c40be',
              sha256: 'c698fc128da40924f58de33c43bb0358cb9a4c9c3b67fc2a7db393eb311c40be',
              byteLength: 11077247,
              bundleManifestSha256:
                '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
              bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
              shardIndex: 0,
              shardCount: 7,
              rosterSha256: '3b6ad65cc4745d7a71d5f5fdd7f9962ba1bf75d23d7e813b987e6c34ab845928',
              memberCount: 19,
              uncompressedByteLength: 25117597,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/0b/0b64475125bea6fb44a06285f1acb3b0024dc55ac2e42d7280910e0bb20e94a2',
              sha256: '0b64475125bea6fb44a06285f1acb3b0024dc55ac2e42d7280910e0bb20e94a2',
              byteLength: 20156014,
              bundleManifestSha256:
                '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
              bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
              shardIndex: 1,
              shardCount: 7,
              rosterSha256: '84bf1c5ee3518342eb6811f21d46ef7c7b8ffd1a13a82ba1f4c05dad67a80483',
              memberCount: 8,
              uncompressedByteLength: 28147639,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/56/5675628645b71e5fa71548264a77a20174438c4c46d7ede2087598d6b11fd1af',
              sha256: '5675628645b71e5fa71548264a77a20174438c4c46d7ede2087598d6b11fd1af',
              byteLength: 15064975,
              bundleManifestSha256:
                '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
              bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
              shardIndex: 2,
              shardCount: 7,
              rosterSha256: 'cdfde8a1e1716fac25c444d567c309f4a4ce2ab706d9eeb86063fbd126ca7761',
              memberCount: 7,
              uncompressedByteLength: 32397915,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/bf/bff4ff0074a57e857e0c219beab41c47f31dd70ef7c5d40283fa98ffbd39220d',
              sha256: 'bff4ff0074a57e857e0c219beab41c47f31dd70ef7c5d40283fa98ffbd39220d',
              byteLength: 20516594,
              bundleManifestSha256:
                '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
              bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
              shardIndex: 3,
              shardCount: 7,
              rosterSha256: '20da69aac848f75563b61da2d8e3a5f61de566f3d64c078ff7f1f8a148ad21ab',
              memberCount: 9,
              uncompressedByteLength: 31620602,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/77/776feb81a47944fa759fb3f213ac860d2956666319db6ab536a6dade99220b3f',
              sha256: '776feb81a47944fa759fb3f213ac860d2956666319db6ab536a6dade99220b3f',
              byteLength: 8741345,
              bundleManifestSha256:
                '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
              bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
              shardIndex: 4,
              shardCount: 7,
              rosterSha256: '9207aff317d0ac989e109afd7b0f35ec6a0c414a5e5738f2b93ad107f79e0eb1',
              memberCount: 10,
              uncompressedByteLength: 14003853,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/7f/7fa081115af31be2dd1cce1c5b3b068dd87adab44e41d82625d15266a81b6bd4',
              sha256: '7fa081115af31be2dd1cce1c5b3b068dd87adab44e41d82625d15266a81b6bd4',
              byteLength: 37987,
              bundleManifestSha256:
                '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
              bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
              shardIndex: 5,
              shardCount: 7,
              rosterSha256: '430220adb807044310dfcc9e97f81d1454c8640f134a91dda33c4f16370f08df',
              memberCount: 6,
              uncompressedByteLength: 251996,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e0/e020134c21acd0e5b66e458b1c536e5efb7e902d2af2b9e7904c2ac045ab40fd',
              sha256: 'e020134c21acd0e5b66e458b1c536e5efb7e902d2af2b9e7904c2ac045ab40fd',
              byteLength: 1635,
              bundleManifestSha256:
                '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
              bundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
              shardIndex: 6,
              shardCount: 7,
              rosterSha256: 'de1b7b221730bd362642370fd0de210247eca4af4d0564d52c5e78d62c303043',
              memberCount: 1,
              uncompressedByteLength: 3685,
            },
          ],
        },
      },
    });
    expect(tair10?.preparedBundle?.fullTierShards?.shards).toHaveLength(7);
  });

  it('pins mm39 to the exact verified individual-object prepared publication', () => {
    const mm39 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'mm39');

    expect(mm39).toMatchObject({
      id: 'mm39',
      provenance: { datasetId: 'GCF_000001635.27' },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/fa/fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
          sha256: 'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
          byteLength: 217600,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: 'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
          bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
          tiers: ['detail', 'search'],
          rosterSha256: 'e4acb3448d1ebbe240e3ce5fb522dbfb4d1da66ee7b8a93afecfa0322f4e5a4c',
          memberCount: 239,
          individualObjectIds: [
            'chr1-fasta',
            'chr10-fasta',
            'chr11-fasta',
            'chr12-fasta',
            'chr13-fasta',
            'chr14-fasta',
            'chr2-fasta',
            'chr3-fasta',
            'chr4-fasta',
            'chr5-fasta',
            'chr6-fasta',
            'chr7-fasta',
            'chr8-fasta',
            'chr9-fasta',
            'chrX-fasta',
            'scene-payload-light-b39cab2b13622c72013e',
            'annotation-search-payload',
            'protein-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/78/78345fd53582e573411b2518b0439d5b7d9bd75c154e44e2315674e6d95d6497',
              sha256: '78345fd53582e573411b2518b0439d5b7d9bd75c154e44e2315674e6d95d6497',
              byteLength: 1190905,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 0,
              shardCount: 31,
              rosterSha256: 'adaa4b31ef8e4d16e5bfbc145b258a263ed4e67999c509ab0c2f2d811ffcaf8a',
              memberCount: 53,
              uncompressedByteLength: 17890257,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/c2/c2a7d6185d299032bfd8b6357c3950f18ab0f30cd49399fdef287a5637a8d7ce',
              sha256: 'c2a7d6185d299032bfd8b6357c3950f18ab0f30cd49399fdef287a5637a8d7ce',
              byteLength: 4937669,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 1,
              shardCount: 31,
              rosterSha256: '8492d4c2de2299793bd71a11f25d7a0f8caf8ef02c4ca7af598848a077c181dd',
              memberCount: 5,
              uncompressedByteLength: 14142047,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/50/5018002ed5ebecc44ad4bc31a5fa918e12549940b9ff834b6f988206155e4d67',
              sha256: '5018002ed5ebecc44ad4bc31a5fa918e12549940b9ff834b6f988206155e4d67',
              byteLength: 4002294,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 2,
              shardCount: 31,
              rosterSha256: '842d2068c68f32bdb2b1d52cb07782f1e78ae8413a068a041f445d3e4e928931',
              memberCount: 5,
              uncompressedByteLength: 16950158,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/32/3246189cc5c6c3bc9e8c5d39ebe26970ae7ddc3ac01522e0a66bcec6044778db',
              sha256: '3246189cc5c6c3bc9e8c5d39ebe26970ae7ddc3ac01522e0a66bcec6044778db',
              byteLength: 4857428,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 3,
              shardCount: 31,
              rosterSha256: '07d01f25af455f4c6fbf279184c23ed3fa7a4b14f38be9f10964404aa06f3deb',
              memberCount: 5,
              uncompressedByteLength: 11904302,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/86/861728a6161d93df370e2f232cd91741615972e7ced1ed990c2b96586431395c',
              sha256: '861728a6161d93df370e2f232cd91741615972e7ced1ed990c2b96586431395c',
              byteLength: 2823993,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 4,
              shardCount: 31,
              rosterSha256: '899e8a2f5b8f4469d1f9a3b527c8324bf2c1964f5d1437dbe0e1da08f1a07a10',
              memberCount: 5,
              uncompressedByteLength: 9455467,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ea/eaaa6f2ae2392c540cb82ff5ae3dbaa410cc955a1ead925c9b971ebdd7c45261',
              sha256: 'eaaa6f2ae2392c540cb82ff5ae3dbaa410cc955a1ead925c9b971ebdd7c45261',
              byteLength: 2649973,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 5,
              shardCount: 31,
              rosterSha256: 'e70f61ca3084370b4aee8650901d4b820adef5800c5c7be4ad9e48f77ee8f43b',
              memberCount: 5,
              uncompressedByteLength: 10296378,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/76/76521a23e002849bf6fc633fb9764892e827e007ebdcb9e3450d80cfb25b6896',
              sha256: '76521a23e002849bf6fc633fb9764892e827e007ebdcb9e3450d80cfb25b6896',
              byteLength: 3083068,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 6,
              shardCount: 31,
              rosterSha256: '243ac91bf0865e9a18e9487d64623cd6eaebb4b84b8648449955a9cab1771b2c',
              memberCount: 5,
              uncompressedByteLength: 10199882,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/d5/d56acf5a8e475c6c7d181aae8d48fcf238c1796256e02d820f96b5c683c8a58a',
              sha256: 'd56acf5a8e475c6c7d181aae8d48fcf238c1796256e02d820f96b5c683c8a58a',
              byteLength: 31859062,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 7,
              shardCount: 31,
              rosterSha256: 'e5c0a9e481b5587c0d1ba6ae3aacf6867a9985d62e701ffc4a03a5949379801a',
              memberCount: 3,
              uncompressedByteLength: 31894598,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/8b/8b33eed3d11acb7e4d2532865b0873b43620af5f90c8e16780fe220c53be8d28',
              sha256: '8b33eed3d11acb7e4d2532865b0873b43620af5f90c8e16780fe220c53be8d28',
              byteLength: 2807484,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 8,
              shardCount: 31,
              rosterSha256: '56530199918b86b09ad8623e891a9db81e1d5313996734b820f67074d29703a2',
              memberCount: 3,
              uncompressedByteLength: 8936895,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/2b/2b621c3cab2143b353ac742d8ed831f5e1bf923c8ad81df76e4af4ecdad1fcbc',
              sha256: '2b621c3cab2143b353ac742d8ed831f5e1bf923c8ad81df76e4af4ecdad1fcbc',
              byteLength: 32044355,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 9,
              shardCount: 31,
              rosterSha256: 'b5489b3328e6bb8e4d0722ff4648229a8594005f8f04a633387a37d20f9dbff8',
              memberCount: 5,
              uncompressedByteLength: 32080839,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/38/38091f911d7e5f081a228914c75a25f8ae16c12cb64278ad31c5963bcd13e534',
              sha256: '38091f911d7e5f081a228914c75a25f8ae16c12cb64278ad31c5963bcd13e534',
              byteLength: 556791,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 10,
              shardCount: 31,
              rosterSha256: '22a63428c4410f005883141add4902c3397c384abee76c020912279c3c8a7dc3',
              memberCount: 1,
              uncompressedByteLength: 8697106,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/77/770230e49a46ad27a95347e771f14dcea59dea20b4c17d2c59fe1c7b26238fe4',
              sha256: '770230e49a46ad27a95347e771f14dcea59dea20b4c17d2c59fe1c7b26238fe4',
              byteLength: 31726143,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 11,
              shardCount: 31,
              rosterSha256: 'e7822cc6a159561d7916f6beb76a1b56c447ef057d46676ab6825469d7e2f345',
              memberCount: 5,
              uncompressedByteLength: 31766296,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e9/e97b169abba0ecc660364fae5f38039613f937482081109cfaaafc2d88a188f7',
              sha256: 'e97b169abba0ecc660364fae5f38039613f937482081109cfaaafc2d88a188f7',
              byteLength: 27975122,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 12,
              shardCount: 31,
              rosterSha256: 'f9f03ebcd403666d2dc283208f5498bb80be46e2bbadcfd9b07637bf327e8465',
              memberCount: 2,
              uncompressedByteLength: 32504981,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/0c/0ce42397609fef1623d24c7b599b7e6e8dbb6d21e1e3caca62b58938e02ab32c',
              sha256: '0ce42397609fef1623d24c7b599b7e6e8dbb6d21e1e3caca62b58938e02ab32c',
              byteLength: 22053865,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 13,
              shardCount: 31,
              rosterSha256: '7f59297e8b2f5d2cdd756936944401cba30daccf82ec507ff6a6ffdee860ec83',
              memberCount: 10,
              uncompressedByteLength: 26985607,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/31/310439184c088afdbaf4e4e390f0ee72a376431e325f113eb86bb0fba0c27410',
              sha256: '310439184c088afdbaf4e4e390f0ee72a376431e325f113eb86bb0fba0c27410',
              byteLength: 992359,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 14,
              shardCount: 31,
              rosterSha256: 'ad1a603feb6c6325fa342878c5069325c3e0aced645ca43a57404c6d9e4c3dd6',
              memberCount: 1,
              uncompressedByteLength: 17016520,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/90/90325bc21afb25188193f79aea31eeaecbc480ff5ac5559aa11a7f2cc9544aef',
              sha256: '90325bc21afb25188193f79aea31eeaecbc480ff5ac5559aa11a7f2cc9544aef',
              byteLength: 6011068,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 15,
              shardCount: 31,
              rosterSha256: 'b72c6c92f23079b5a509a2e860079388caa771cfb00a13f3105123b915e17070',
              memberCount: 5,
              uncompressedByteLength: 14948381,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/62/625c74f1e4b769449754b096e5fe8c9a509246270250bad51b601b3568db5d51',
              sha256: '625c74f1e4b769449754b096e5fe8c9a509246270250bad51b601b3568db5d51',
              byteLength: 3746257,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 16,
              shardCount: 31,
              rosterSha256: '226fde79cb30e09a47136ed5d50845db10ba94e7656ebb35883e115a11cbef0a',
              memberCount: 5,
              uncompressedByteLength: 15292194,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/41/41e5c6caa083f228dfe6cdadb077af606866309ae1b2bc0e271ab8043d4869cc',
              sha256: '41e5c6caa083f228dfe6cdadb077af606866309ae1b2bc0e271ab8043d4869cc',
              byteLength: 4594243,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 17,
              shardCount: 31,
              rosterSha256: '5a1cf0fb07e75d556e2654dac21c4f648ba949fbe05c8e98992bc776c688048b',
              memberCount: 5,
              uncompressedByteLength: 16473283,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/46/4624cc71e46d6154bdebb14800b1859db3684b2c3192ddc7208abe447a0ade0a',
              sha256: '4624cc71e46d6154bdebb14800b1859db3684b2c3192ddc7208abe447a0ade0a',
              byteLength: 4709735,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 18,
              shardCount: 31,
              rosterSha256: 'cf7170ac2638ed5a7b20313bae4a1283a3b9f8282079999a1e239593b0381ed0',
              memberCount: 5,
              uncompressedByteLength: 14566170,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/59/5996bc7e52bf8fd5cb133c51d8bcedb912502073dc1365e007517fe0c08d3b47',
              sha256: '5996bc7e52bf8fd5cb133c51d8bcedb912502073dc1365e007517fe0c08d3b47',
              byteLength: 4262491,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 19,
              shardCount: 31,
              rosterSha256: '966cae03752df23fc5f5476d70d5f2d3cabf2ba01d7b540dff7dbe73416de0db',
              memberCount: 5,
              uncompressedByteLength: 17238882,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/18/1858ec1011623bdedc12c4b7134139606b1ca3199a9e77bba435cb0962cee48b',
              sha256: '1858ec1011623bdedc12c4b7134139606b1ca3199a9e77bba435cb0962cee48b',
              byteLength: 4895097,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 20,
              shardCount: 31,
              rosterSha256: '0c35afba29ed956f001f623a129bcf1e8f9666be8098f7355ae1e9121fc7bc86',
              memberCount: 5,
              uncompressedByteLength: 13709914,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/2e/2ea14daac3a87879d4d7f32c42604ce5341a9d42cc55c06afd24bc3d0454ed36',
              sha256: '2ea14daac3a87879d4d7f32c42604ce5341a9d42cc55c06afd24bc3d0454ed36',
              byteLength: 3630340,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 21,
              shardCount: 31,
              rosterSha256: 'bb1193dd319725d791db604aa416c70001f41b840ca888c8b2f123ec4e6a5b6b',
              memberCount: 5,
              uncompressedByteLength: 14184132,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e6/e6fad683cd8bdce69b0badb41db24adf0307f515714921ba2cbbc4cec0764e18',
              sha256: 'e6fad683cd8bdce69b0badb41db24adf0307f515714921ba2cbbc4cec0764e18',
              byteLength: 4108696,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 22,
              shardCount: 31,
              rosterSha256: 'bf25ce784da9a9eb851bd010e74af41017ffa0e65ed99a2af691d53ebd3c81ff',
              memberCount: 11,
              uncompressedByteLength: 10635024,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/b5/b5830702b20846e7b92710f61a7210cd8a1719b439b5c2d93bfa3433e9e45c9b',
              sha256: 'b5830702b20846e7b92710f61a7210cd8a1719b439b5c2d93bfa3433e9e45c9b',
              byteLength: 30074494,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 23,
              shardCount: 31,
              rosterSha256: '25814e1281a9c2d1cfe212e69d14ccebb31dbdca55bc7197e52ce4478f5d1621',
              memberCount: 10,
              uncompressedByteLength: 30580974,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/55/557075119131deb4e5e579834e40585034f9024f28b67cbf27798758dbfcaddd',
              sha256: '557075119131deb4e5e579834e40585034f9024f28b67cbf27798758dbfcaddd',
              byteLength: 5074192,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 24,
              shardCount: 31,
              rosterSha256: '56454db285eb12fa86045bfa141acf148764cb7c8ce43a2913ae01bc3593f6dd',
              memberCount: 14,
              uncompressedByteLength: 32468758,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/46/46e430f20990a80a6baabda128eb9f7dbdc909257b7719ea610a2726e563b7f8',
              sha256: '46e430f20990a80a6baabda128eb9f7dbdc909257b7719ea610a2726e563b7f8',
              byteLength: 243696,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 25,
              shardCount: 31,
              rosterSha256: 'f189e2323b9817f8a070623a173a909d1c5aa3f7b4b591e5693a22ed6da60d61',
              memberCount: 21,
              uncompressedByteLength: 2783370,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/57/57df0bf783f29661e686949cd809281947a7bc8968d3760f0a8d3f9addc568be',
              sha256: '57df0bf783f29661e686949cd809281947a7bc8968d3760f0a8d3f9addc568be',
              byteLength: 4982112,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 26,
              shardCount: 31,
              rosterSha256: '9ff12caf8b5b249cc67f8b6264a2e97a0b1ea3bf691b99ab1bb6f96fd8e218ca',
              memberCount: 5,
              uncompressedByteLength: 26973384,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/46/466b749aec19c2169976917017bf25b4583fc6d3430615191dcf14a9750f1d85',
              sha256: '466b749aec19c2169976917017bf25b4583fc6d3430615191dcf14a9750f1d85',
              byteLength: 3600649,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 27,
              shardCount: 31,
              rosterSha256: 'f403aabd4533c5b6ec3d808e7f7d2337ee828506ec4ad406ac4230ebea88608b',
              memberCount: 5,
              uncompressedByteLength: 22468440,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/f8/f8f66dfa63f94436ec0165ec0b6420d75af2027ee5ec78df3a440929aa1c85f6',
              sha256: 'f8f66dfa63f94436ec0165ec0b6420d75af2027ee5ec78df3a440929aa1c85f6',
              byteLength: 2476837,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 28,
              shardCount: 31,
              rosterSha256: 'b86b330a7a65a656c5549505a8eabab4ea7447cfa14d6959301bd79160aaaf9f',
              memberCount: 2,
              uncompressedByteLength: 18307947,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/12/12959602f8595afa9423e393a3cc5c3828cc22ad41dc3205436657796d1ee0c5',
              sha256: '12959602f8595afa9423e393a3cc5c3828cc22ad41dc3205436657796d1ee0c5',
              byteLength: 3215868,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 29,
              shardCount: 31,
              rosterSha256: 'b61819e198b2174a64a49aa6ae73fca6113c313783a651ff1d534ab086ec78a8',
              memberCount: 4,
              uncompressedByteLength: 19940775,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/3a/3adc5ae72fa230d1480659749fa0d15aeca0ccc70fc56634a5f232eb686194c4',
              sha256: '3adc5ae72fa230d1480659749fa0d15aeca0ccc70fc56634a5f232eb686194c4',
              byteLength: 2064,
              bundleManifestSha256:
                'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
              bundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
              shardIndex: 30,
              shardCount: 31,
              rosterSha256: 'd439ed49d56c40217b7e6446f5b4d5ba8a2269390948eb96a17f7efcaf54c1fe',
              memberCount: 1,
              uncompressedByteLength: 5365,
            },
          ],
        },
      },
    });
    expect(mm39?.preparedBundle).not.toHaveProperty('firstViewPack');
    expect(mm39?.preparedBundle).not.toHaveProperty('legacyLayerIdentityContract');
    expect(mm39?.preparedBundle?.fullTierShards?.shards).toHaveLength(31);
  });

  it('pins grcz12tu to the exact verified prepared publication', () => {
    const grcz12tu = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'grcz12tu');

    expect(grcz12tu).toMatchObject({
      id: 'grcz12tu',
      provenance: { datasetId: 'GCF_049306965.2' },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/fb/fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
          sha256: 'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
          byteLength: 120193,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/bc/bcdfda150189852b3754232d7ba4deb4e01e3181dae11e372dbe2b1eb24ed0a6',
          sha256: 'bcdfda150189852b3754232d7ba4deb4e01e3181dae11e372dbe2b1eb24ed0a6',
          byteLength: 11579517,
          bundleManifestSha256: 'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
          bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
          tiers: ['shell', 'view'],
          rosterSha256: '909a5a4902ff74bbfc4273058d65692369d91aaad77469065e4c20afcca3c0a0',
          memberCount: 56,
          uncompressedByteLength: 71503704,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: 'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
          bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
          tiers: ['detail', 'search'],
          rosterSha256: '3e86aea93bcfab9e6d8c26ee12531e7a34255eb73cc30649bc3cef77c85c62ce',
          memberCount: 191,
          individualObjectIds: [
            'scene-payload-light-49c0d029fc1558e0b6a2',
            'scene-payload-light-d1fd0a35699b12286b3c',
            'annotation-search-payload',
            'protein-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/67/67b77fef819d12de7b7887ce96d2caf2b3ed47492198f123a11af341c985cbb7',
              sha256: '67b77fef819d12de7b7887ce96d2caf2b3ed47492198f123a11af341c985cbb7',
              byteLength: 20011354,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 0,
              shardCount: 32,
              rosterSha256: 'cb268c3a7a54f741106eb56d353c4bced0e168f6d791dffd56a2d4a7ea5e059e',
              memberCount: 23,
              uncompressedByteLength: 31117722,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/c2/c2381746cd92e35eeb3811f6549e2a24400518b1c9ff1bc59f95935e2c048d44',
              sha256: 'c2381746cd92e35eeb3811f6549e2a24400518b1c9ff1bc59f95935e2c048d44',
              byteLength: 20552006,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 1,
              shardCount: 32,
              rosterSha256: '1e2e6c2894020e105f8a41a6518332d572308eae4ee336661b2388f222e0fc76',
              memberCount: 9,
              uncompressedByteLength: 31818152,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e8/e80a6f1025943b011e23237747b0c12f8394c22d18d085804626da2709246fa3',
              sha256: 'e80a6f1025943b011e23237747b0c12f8394c22d18d085804626da2709246fa3',
              byteLength: 17138748,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 2,
              shardCount: 32,
              rosterSha256: '703a480eedc57d262030c4aa8c4d5a5afc63f8fda80d60f7a095dc97aa4e6718',
              memberCount: 6,
              uncompressedByteLength: 22797661,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/b8/b83d8dfea892975fa75c3950427c0f0cac0fb62ec6bcdc9d260546dc053a1e1f',
              sha256: 'b83d8dfea892975fa75c3950427c0f0cac0fb62ec6bcdc9d260546dc053a1e1f',
              byteLength: 18280531,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 3,
              shardCount: 32,
              rosterSha256: 'b7d629104c5f1982a58b4caabfd1933da4182d11bb99309df14866480c94303d',
              memberCount: 6,
              uncompressedByteLength: 25064765,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/8f/8fb9ccc44ee28b4f0337319a0bc92854afe9ef911e6d560d62c8429cf3d8199e',
              sha256: '8fb9ccc44ee28b4f0337319a0bc92854afe9ef911e6d560d62c8429cf3d8199e',
              byteLength: 19989636,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 4,
              shardCount: 32,
              rosterSha256: '81d1a0d3148a192bda3940ee12a6665204c5f37fa3f1bf6f00f8ffa80279f44d',
              memberCount: 6,
              uncompressedByteLength: 24481797,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/28/2812d4bc31b9269ee1f2ca607e2312dba582efcc9ec5a8e83eb2d59f6c94e328',
              sha256: '2812d4bc31b9269ee1f2ca607e2312dba582efcc9ec5a8e83eb2d59f6c94e328',
              byteLength: 19677706,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 5,
              shardCount: 32,
              rosterSha256: 'e4ab503eef712e6c20e9b1d2a1301d20fbb86334ab37a02c1d4529d8ba03c3aa',
              memberCount: 6,
              uncompressedByteLength: 25214814,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/64/64e7014aaa01e6b226ef2484600ca5598b506d04022ab5426bdfebfb88153543',
              sha256: '64e7014aaa01e6b226ef2484600ca5598b506d04022ab5426bdfebfb88153543',
              byteLength: 18292937,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 6,
              shardCount: 32,
              rosterSha256: 'f3b5b6c64ca14ea024349fd13c6b34288e347286f129efb73ec6447f2263dcea',
              memberCount: 6,
              uncompressedByteLength: 25204561,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/9d/9d2b213c17d752cfedc1741438fc4bdc6be23aeaa6dafdac91de0ba33a2397e8',
              sha256: '9d2b213c17d752cfedc1741438fc4bdc6be23aeaa6dafdac91de0ba33a2397e8',
              byteLength: 20981715,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 7,
              shardCount: 32,
              rosterSha256: '244010587a9173c00baa3d4b0ebf90a740ce31fa1010a7bccce4cda164d23cf6',
              memberCount: 6,
              uncompressedByteLength: 27084041,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/af/afa01c6ae21ff609495836b5324edf798784bf776540347dbdc221adf56a1d15',
              sha256: 'afa01c6ae21ff609495836b5324edf798784bf776540347dbdc221adf56a1d15',
              byteLength: 20353906,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 8,
              shardCount: 32,
              rosterSha256: 'a850080008083dc845d0b9256c919a4cf373e0f187a27419406bd9f183bda779',
              memberCount: 6,
              uncompressedByteLength: 25538715,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/8a/8a74c4dd8f1b08c48b7fa93aff14b55d5bef91a791464d910155037f9eeb65af',
              sha256: '8a74c4dd8f1b08c48b7fa93aff14b55d5bef91a791464d910155037f9eeb65af',
              byteLength: 18838528,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 9,
              shardCount: 32,
              rosterSha256: '3ff44d396e731ae4443a15b88a9780ff172ed625a32e1185cf9671e7787c4a79',
              memberCount: 6,
              uncompressedByteLength: 24047057,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/69/696ff83b4452f93350fc2c9d862c77c8916d395115db49c089057a12be8896cf',
              sha256: '696ff83b4452f93350fc2c9d862c77c8916d395115db49c089057a12be8896cf',
              byteLength: 18230088,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 10,
              shardCount: 32,
              rosterSha256: '936131f615a49c4277b9fed8e2680f04f7126ffbd177e2da2bd45bb18b0ddc09',
              memberCount: 6,
              uncompressedByteLength: 25449291,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/fb/fbbdfbf167ed31b2dd846155e5ab588f136b17ef263e14021232e1f1ed305876',
              sha256: 'fbbdfbf167ed31b2dd846155e5ab588f136b17ef263e14021232e1f1ed305876',
              byteLength: 22391564,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 11,
              shardCount: 32,
              rosterSha256: '3b9f243afe4edf27a047d0df481b0e01d833c42591164259a08fa7c7ca64bc16',
              memberCount: 6,
              uncompressedByteLength: 29329553,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/bb/bba966e31effe9b15f742b40af242b3c1ef967a37c3815397342c06d9a3a0a60',
              sha256: 'bba966e31effe9b15f742b40af242b3c1ef967a37c3815397342c06d9a3a0a60',
              byteLength: 20892956,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 12,
              shardCount: 32,
              rosterSha256: 'f6148293596af98e22e6b40f0c81760a927c4af21e692e1c3cc4c854ec0a6adf',
              memberCount: 6,
              uncompressedByteLength: 27149542,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/84/84e0eefd301540e0a9444ba665bf8a54d86ee155abda026d2375c375fd9053e2',
              sha256: '84e0eefd301540e0a9444ba665bf8a54d86ee155abda026d2375c375fd9053e2',
              byteLength: 17951389,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 13,
              shardCount: 32,
              rosterSha256: '207260a729de3709e6fc183ab86335c6ec681f27c8e48bb935c75ce11f95f922',
              memberCount: 6,
              uncompressedByteLength: 22919826,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/d6/d6e43a7cf9180c800e6106194a23b9c46a91b5691fdcf46539d395086a056ebb',
              sha256: 'd6e43a7cf9180c800e6106194a23b9c46a91b5691fdcf46539d395086a056ebb',
              byteLength: 14688346,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 14,
              shardCount: 32,
              rosterSha256: '0e4c897272c1a317f933538fc00e72a9dd6a20a1d6d704aa4ae4e5ba4c5764d7',
              memberCount: 6,
              uncompressedByteLength: 21259832,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ca/cab7dd0c51850b9798a71f7c8c2ce3d9040e900390ea2ad1cd40771f4123df62',
              sha256: 'cab7dd0c51850b9798a71f7c8c2ce3d9040e900390ea2ad1cd40771f4123df62',
              byteLength: 18061702,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 15,
              shardCount: 32,
              rosterSha256: '60ff1f0899b1f5a0bf58c0c265aa6c6a1808e822cf2dc927a8b37d279f3d75a6',
              memberCount: 6,
              uncompressedByteLength: 23210081,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/14/14f092e28be03a0b89a23a273350c83a2b8e188bd2cc5d941eaffd7cb323cf0d',
              sha256: '14f092e28be03a0b89a23a273350c83a2b8e188bd2cc5d941eaffd7cb323cf0d',
              byteLength: 16069354,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 16,
              shardCount: 32,
              rosterSha256: '976adb02f52a9fbc40278c664a4d9e9738cef8dceda21f53ca52c9cc0f82f4f2',
              memberCount: 6,
              uncompressedByteLength: 21445357,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/3c/3c11f9434c78fe8d57eb08d1ee37c9de5eb3adc1743246aea215c55dee56f313',
              sha256: '3c11f9434c78fe8d57eb08d1ee37c9de5eb3adc1743246aea215c55dee56f313',
              byteLength: 14731807,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 17,
              shardCount: 32,
              rosterSha256: '0dc716491ff742bfec978996d62e5d8fda13988315f289b8c25449f79f3339fd',
              memberCount: 6,
              uncompressedByteLength: 21815760,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/0f/0f88f8909f8cb139eb0574aa1de289dfe3af24ab15d309caae449e6ac7f33ce1',
              sha256: '0f88f8909f8cb139eb0574aa1de289dfe3af24ab15d309caae449e6ac7f33ce1',
              byteLength: 22809155,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 18,
              shardCount: 32,
              rosterSha256: '1408046b45f99b343683c650572cb09a4c82ca52c1bbdbabbf9340bfa0a41814',
              memberCount: 5,
              uncompressedByteLength: 22836348,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e8/e831faf15ac3811941e3dc9637534ce1cff4073022917fc32752c40eb8fa7797',
              sha256: 'e831faf15ac3811941e3dc9637534ce1cff4073022917fc32752c40eb8fa7797',
              byteLength: 1069460,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 19,
              shardCount: 32,
              rosterSha256: 'e63c0c50f7e08729d5d3dfa48ba5f2889158c8693cc3c6ab0bd0e86e138c085d',
              memberCount: 1,
              uncompressedByteLength: 15646739,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/e4/e44f859e39ccb4e081064ad311328e691a70edd25f12c4c11a7ecd6f05246663',
              sha256: 'e44f859e39ccb4e081064ad311328e691a70edd25f12c4c11a7ecd6f05246663',
              byteLength: 26209388,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 20,
              shardCount: 32,
              rosterSha256: '2d22b28334d7ed0f71c745656a0fd802998f590f3450563b5185643396ecd2b4',
              memberCount: 5,
              uncompressedByteLength: 26263999,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ab/ab4f86d1649ae035dddc676592ad8881dafe19fbb1c2a5bdc92031447b2ef7e4',
              sha256: 'ab4f86d1649ae035dddc676592ad8881dafe19fbb1c2a5bdc92031447b2ef7e4',
              byteLength: 564846,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 21,
              shardCount: 32,
              rosterSha256: '5a876d68dd0d0839ea130053132c287b04eeaad5db8e4b864b0aa17bef1a4243',
              memberCount: 1,
              uncompressedByteLength: 9441784,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/29/29601241746f38fac9e31be3ec1d4fbc16180d8e1960d075a02c406aab573b31',
              sha256: '29601241746f38fac9e31be3ec1d4fbc16180d8e1960d075a02c406aab573b31',
              byteLength: 26862108,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 22,
              shardCount: 32,
              rosterSha256: '0c757e1eb71f626d38189b5115ce2a5bf9c5231252b0f2c98e7c68f0ffeffcab',
              memberCount: 5,
              uncompressedByteLength: 26905900,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/bb/bb2b9bedd8f61e1ffcd3b6b091c76346ab94b923d26e2badb2b766d9d7f7b46a',
              sha256: 'bb2b9bedd8f61e1ffcd3b6b091c76346ab94b923d26e2badb2b766d9d7f7b46a',
              byteLength: 22776460,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 23,
              shardCount: 32,
              rosterSha256: '8d7e001052d369b24c72fd6aec89f89a2ee1964668c029ce231e32490503c0aa',
              memberCount: 6,
              uncompressedByteLength: 30465970,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/40/40112da1d4784d720013ccbe441fafe2a924aa6115f4dee110fd880b84fa6df0',
              sha256: '40112da1d4784d720013ccbe441fafe2a924aa6115f4dee110fd880b84fa6df0',
              byteLength: 527254,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 24,
              shardCount: 32,
              rosterSha256: 'd6d8cbbac432fad49183c1c4ca810d9f7d8bb812e7f886393e3860f11ecb2772',
              memberCount: 1,
              uncompressedByteLength: 9333724,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/75/7520a6f92a8507f5ede2f499d24e23bc80405277df3de01ffebdbd6d7078c432',
              sha256: '7520a6f92a8507f5ede2f499d24e23bc80405277df3de01ffebdbd6d7078c432',
              byteLength: 27634489,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 25,
              shardCount: 32,
              rosterSha256: 'f443ca74e23a7c77c2334e52c9d90f91fa66918138df885ca105f6412f1c834a',
              memberCount: 5,
              uncompressedByteLength: 27694889,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/03/031ab858680ee40eb0e5372a3e2a22b1055bf4a943e6e7820440b561e0a695dd',
              sha256: '031ab858680ee40eb0e5372a3e2a22b1055bf4a943e6e7820440b561e0a695dd',
              byteLength: 22029881,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 26,
              shardCount: 32,
              rosterSha256: '5cdaa125c381f91e076e392f79d37431ef3080c1f6c7c443ae508a8f3cac2c92',
              memberCount: 6,
              uncompressedByteLength: 28775332,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/32/32637bfcb65082795b0c7fbdd474579af2921489b6fb1b43ef3d88ce58c86d70',
              sha256: '32637bfcb65082795b0c7fbdd474579af2921489b6fb1b43ef3d88ce58c86d70',
              byteLength: 21317383,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 27,
              shardCount: 32,
              rosterSha256: '97a60d06ad5a628f4395ccc6cfe2d031e6f589ae55a76976bee5551d28440a8d',
              memberCount: 9,
              uncompressedByteLength: 29097769,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/22/22f690d7bafbb66f09eeff903e041f3bcbf38f17a3cb8b1bced3695f8cdc8405',
              sha256: '22f690d7bafbb66f09eeff903e041f3bcbf38f17a3cb8b1bced3695f8cdc8405',
              byteLength: 3647937,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 28,
              shardCount: 32,
              rosterSha256: 'a866411b36188943bae677fce6bf137623c74145a72c200ab6bca7f457033a18',
              memberCount: 1,
              uncompressedByteLength: 26548391,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/db/dbc43505a4ab829b7a77a869c8f6da26c8d9caff33cb047bdf0a41d463dd9cfd',
              sha256: 'dbc43505a4ab829b7a77a869c8f6da26c8d9caff33cb047bdf0a41d463dd9cfd',
              byteLength: 3300782,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 29,
              shardCount: 32,
              rosterSha256: 'e69c84360ee9e3e124303e00f0a78f2a6a9f0ab1140dd030e7846c4eb7fd3ac0',
              memberCount: 10,
              uncompressedByteLength: 21470955,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/31/317832bc78cf6c0a71361acbd590bb61ae9d9f713ac063bc5cdd12b3bf676282',
              sha256: '317832bc78cf6c0a71361acbd590bb61ae9d9f713ac063bc5cdd12b3bf676282',
              byteLength: 37255,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 30,
              shardCount: 32,
              rosterSha256: 'fac0a33efe125ab99de713300a37043f2733a1178cfe5fa00c480bc4fd7655a2',
              memberCount: 3,
              uncompressedByteLength: 271228,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ca/ca98736a6e4d9fc9c7fa67e382b8e2d7fd0a861cd669564b2c5a945a612daea2',
              sha256: 'ca98736a6e4d9fc9c7fa67e382b8e2d7fd0a861cd669564b2c5a945a612daea2',
              byteLength: 2054,
              bundleManifestSha256:
                'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
              bundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
              shardIndex: 31,
              shardCount: 32,
              rosterSha256: 'e1ef9842ca9836005f2999da27275e07df114e71db95914909fbe2718555ec51',
              memberCount: 1,
              uncompressedByteLength: 5490,
            },
          ],
        },
      },
    });
    expect(grcz12tu?.preparedBundle).not.toHaveProperty('legacyLayerIdentityContract');
    expect(grcz12tu?.preparedBundle?.fullTierShards?.shards).toHaveLength(32);
  });

  it('pins dm6 to the exact verified prepared publication', () => {
    const dm6 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'dm6');

    expect(dm6).toMatchObject({
      id: 'dm6',
      provenance: { datasetId: 'GCF_000001215.4' },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/e6/e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
          sha256: 'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
          byteLength: 479400,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/8a/8abdbd3ab929b2b5439ab13ca3fc4a7f650b96cd2defcf6da3398a7cad66854a',
          sha256: '8abdbd3ab929b2b5439ab13ca3fc4a7f650b96cd2defcf6da3398a7cad66854a',
          byteLength: 3107146,
          bundleManifestSha256: 'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
          bundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
          tiers: ['shell', 'view'],
          rosterSha256: 'bf7dfcd7c09e4aa0e0091bff091549ba64f77034e2a51b78951ecbe46e41ad11',
          memberCount: 434,
          uncompressedByteLength: 20835075,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: 'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
          bundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
          tiers: ['detail', 'search'],
          rosterSha256: '095f60dc39c40858dc62ad5c4a0d63215aad8d31c91f0f7682df8a9269327c92',
          memberCount: 341,
          individualObjectIds: [
            'scene-payload-light-4c6e26320de9f95f6339',
            'annotation-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/8b/8b40c4c3523730c8dad57b1d9e7b907388462192acbc23589b085050395034a4',
              sha256: '8b40c4c3523730c8dad57b1d9e7b907388462192acbc23589b085050395034a4',
              byteLength: 18949970,
              bundleManifestSha256:
                'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
              bundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
              shardIndex: 0,
              shardCount: 5,
              rosterSha256: '2b6078f48baf11d245492d3eaa96ea83504e0d66247e261b32a876906de9331c',
              memberCount: 155,
              uncompressedByteLength: 31335343,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/34/3409e0d0acfe48b534b505ef3d71fa17bc0c3e95b212dd4c83c9506d4d30d3e6',
              sha256: '3409e0d0acfe48b534b505ef3d71fa17bc0c3e95b212dd4c83c9506d4d30d3e6',
              byteLength: 14854853,
              bundleManifestSha256:
                'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
              bundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
              shardIndex: 1,
              shardCount: 5,
              rosterSha256: 'b24a2c0795dffed0b0bdc5103d6a4ccf53b74a36d13e1e7b67de109f153df300',
              memberCount: 9,
              uncompressedByteLength: 27514251,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/25/25a31562265e28d3fbeb6cb5291071875ca6aae2fb6b316921bd1ac5f746d909',
              sha256: '25a31562265e28d3fbeb6cb5291071875ca6aae2fb6b316921bd1ac5f746d909',
              byteLength: 24866319,
              bundleManifestSha256:
                'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
              bundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
              shardIndex: 2,
              shardCount: 5,
              rosterSha256: 'e42cadb743dcaa2a38674580e7b6cc69248d8718f5607d56da4cd8386cda7e8f',
              memberCount: 60,
              uncompressedByteLength: 31491658,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/b2/b29d27345afcf1aad025dca4de3518a657f2eaca76b86d4364098737c0a36800',
              sha256: 'b29d27345afcf1aad025dca4de3518a657f2eaca76b86d4364098737c0a36800',
              byteLength: 748295,
              bundleManifestSha256:
                'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
              bundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
              shardIndex: 3,
              shardCount: 5,
              rosterSha256: '7348c446776ae2d27ab1eb870486f92210ce7c231593262feb7caa5cd3753776',
              memberCount: 113,
              uncompressedByteLength: 5144492,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/cc/cc7aac4372c3e0a24c4521b1470108569f0832268196f214756869ca86cb47e9',
              sha256: 'cc7aac4372c3e0a24c4521b1470108569f0832268196f214756869ca86cb47e9',
              byteLength: 6048760,
              bundleManifestSha256:
                'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
              bundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
              shardIndex: 4,
              shardCount: 5,
              rosterSha256: '6ecfd04ec22836189522618d4e2ecbc1394c1b5d28ca6b6982dae597e405a871',
              memberCount: 2,
              uncompressedByteLength: 31955033,
            },
          ],
        },
      },
    });
    expect(dm6?.preparedBundle).not.toHaveProperty('legacyLayerIdentityContract');
    expect(dm6?.preparedBundle?.fullTierShards?.shards).toHaveLength(5);
  });

  it('pins xenTro10 to the exact verified prepared publication', () => {
    const xenTro10 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'xenTro10');

    expect(xenTro10).toMatchObject({
      id: 'xenTro10',
      provenance: { datasetId: 'GCF_000004195.4' },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/9c/9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
          sha256: '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
          byteLength: 87253,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/f2/f2966f716381255b9c967f0a3889f108fe80542731cbceb9b216e00de3665035',
          sha256: 'f2966f716381255b9c967f0a3889f108fe80542731cbceb9b216e00de3665035',
          byteLength: 5635310,
          bundleManifestSha256: '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
          bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
          tiers: ['shell', 'view'],
          rosterSha256: '99f61e79171195de3ebffafad4b1d34820ea949f038a2dd1a53ec500a6ba96dc',
          memberCount: 56,
          uncompressedByteLength: 35385724,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
          bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
          tiers: ['detail', 'search'],
          rosterSha256: '9352601b6ea166065dbe0b1b9b50185fd357a108114c30206d9bb3daef120252',
          memberCount: 107,
          individualObjectIds: [
            'chr1-fasta',
            'chr2-fasta',
            'chr3-fasta',
            'chr4-fasta',
            'chr5-fasta',
            'chr6-fasta',
            'chr7-fasta',
            'chr8-fasta',
            'scene-payload-light-7048677bea0daf275d4c',
            'annotation-search-payload',
            'protein-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/78/78e7f171439fdb6c9fde283a63561c2be10c33ef5ba88e17c812e0c43c4bc176',
              sha256: '78e7f171439fdb6c9fde283a63561c2be10c33ef5ba88e17c812e0c43c4bc176',
              byteLength: 1028519,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 0,
              shardCount: 14,
              rosterSha256: '5b04805ab5299522b48d80c02604aa92c35e59f5ad70402261b542675fad950c',
              memberCount: 20,
              uncompressedByteLength: 12267727,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ee/ee0deca93b094d70dac2d5a88ecd0c069f79193d38517a9fd853104102fb58b4',
              sha256: 'ee0deca93b094d70dac2d5a88ecd0c069f79193d38517a9fd853104102fb58b4',
              byteLength: 19608909,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 1,
              shardCount: 14,
              rosterSha256: '51e433dca5a0e852a142205d1c7389bd2e771f5fa2ff40c4699c834a3aa6d380',
              memberCount: 10,
              uncompressedByteLength: 23106747,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/18/1819e8a73bf28a994d7990f24eccd030bcafcc619741d31e75e0f1cb61c1746d',
              sha256: '1819e8a73bf28a994d7990f24eccd030bcafcc619741d31e75e0f1cb61c1746d',
              byteLength: 747529,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 2,
              shardCount: 14,
              rosterSha256: '59493983b6ccc74174f875ab2153f7d5d3b30cc1f382f06aaea66c1f5686175d',
              memberCount: 1,
              uncompressedByteLength: 9860208,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/93/937f6c5437b5d3335e69614dce478cd175714ce69a98514b8e48d2ec6569c841',
              sha256: '937f6c5437b5d3335e69614dce478cd175714ce69a98514b8e48d2ec6569c841',
              byteLength: 3771378,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 3,
              shardCount: 14,
              rosterSha256: '373eb2ab18cb8a44ca3f483b2e1d41e0b0e6e8ee92b656984e544ecae24c8444',
              memberCount: 5,
              uncompressedByteLength: 12999017,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/23/23328ffa0ba55dc357080de3f399e1504e755bb87273d054d911f89c019eb37c',
              sha256: '23328ffa0ba55dc357080de3f399e1504e755bb87273d054d911f89c019eb37c',
              byteLength: 3583351,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 4,
              shardCount: 14,
              rosterSha256: '004834b7618bf04cfb53aedf375a2c624eca4ac80994b564ac3f5f1d8ba28892',
              memberCount: 5,
              uncompressedByteLength: 11447023,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/47/47713b300c5d7ded16b8f0be606f15a67c8f3249307e51914a05c6657403b656',
              sha256: '47713b300c5d7ded16b8f0be606f15a67c8f3249307e51914a05c6657403b656',
              byteLength: 3187947,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 5,
              shardCount: 14,
              rosterSha256: 'c9408a5de0b488abffa07253feec6396bf25ce430f6a16f99c07bd32bf49f505',
              memberCount: 5,
              uncompressedByteLength: 10014800,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/7e/7e2b93b4bb309130a5ef70262232e89a7ce30af744c780a57263efcd27758f69',
              sha256: '7e2b93b4bb309130a5ef70262232e89a7ce30af744c780a57263efcd27758f69',
              byteLength: 2738643,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 6,
              shardCount: 14,
              rosterSha256: '522c04aab4e3928da7709987eca9c76526808bd372d037fa2067335c34706ddf',
              memberCount: 5,
              uncompressedByteLength: 8741314,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/9a/9af741cbafa2db821bbd9064cb0a8c5bf8c03bbb20e9977d73c353860fd8d75c',
              sha256: '9af741cbafa2db821bbd9064cb0a8c5bf8c03bbb20e9977d73c353860fd8d75c',
              byteLength: 2542379,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 7,
              shardCount: 14,
              rosterSha256: 'be6d0a85adb69e573c1e000b1545e22c6da29ab350339233cf376cadedd214a8',
              memberCount: 5,
              uncompressedByteLength: 9763415,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ad/ad50dbfdd84b6f58ebea9280d6ef79d2d3a3a0c8943536680200257a6bf1e129',
              sha256: 'ad50dbfdd84b6f58ebea9280d6ef79d2d3a3a0c8943536680200257a6bf1e129',
              byteLength: 3141493,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 8,
              shardCount: 14,
              rosterSha256: '34c4954145e7ad2677a0596d9fa568c3f03da4f9f1d7699932bd7e5d5408c463',
              memberCount: 5,
              uncompressedByteLength: 11531784,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/d3/d368d794be6442a639690693595f421a3fb39ed49177f61953e64246ef1060fe',
              sha256: 'd368d794be6442a639690693595f421a3fb39ed49177f61953e64246ef1060fe',
              byteLength: 3087578,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 9,
              shardCount: 14,
              rosterSha256: '7213e0e83579a09dd8c3e32ad6328cca7426569ab544aa8bc0a78f291d19935c',
              memberCount: 5,
              uncompressedByteLength: 8649697,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/d5/d586f11c60751e43933dd6271314a73bb127c0651b7845cb5a88fdbf795a8c93',
              sha256: 'd586f11c60751e43933dd6271314a73bb127c0651b7845cb5a88fdbf795a8c93',
              byteLength: 29156913,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 10,
              shardCount: 14,
              rosterSha256: 'dbb25a40c13c2b82f9f60e2d334e489b492ffc1791d6843d21e84778ce693aa3',
              memberCount: 17,
              uncompressedByteLength: 30718581,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/bf/bfddcc590a799717629f9cf4ed17ebd8b1bf59e0a70c9feaa4f4b31c48d7f6d9',
              sha256: 'bfddcc590a799717629f9cf4ed17ebd8b1bf59e0a70c9feaa4f4b31c48d7f6d9',
              byteLength: 584123,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 11,
              shardCount: 14,
              rosterSha256: '7559a1bf02d74ab787d5572fc05b89b6fae3f6fa48839bb50ac73fcedfc2c403',
              memberCount: 2,
              uncompressedByteLength: 5306464,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/cd/cd3a0089c2dd4b8a246a4da72344fa090add56dca9a8927d1fb3b6590c0dc9cf',
              sha256: 'cd3a0089c2dd4b8a246a4da72344fa090add56dca9a8927d1fb3b6590c0dc9cf',
              byteLength: 2315512,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 12,
              shardCount: 14,
              rosterSha256: '5cf4b0b5f3c279363372c386c51a23002870b2f4e7827553a22501c034586fbd',
              memberCount: 10,
              uncompressedByteLength: 17053567,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/2a/2a961874deca15fe30d7c30198385e7a6158421e00b533ce7b2322f55edc5f84',
              sha256: '2a961874deca15fe30d7c30198385e7a6158421e00b533ce7b2322f55edc5f84',
              byteLength: 1764,
              bundleManifestSha256:
                '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
              bundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
              shardIndex: 13,
              shardCount: 14,
              rosterSha256: '05c0edfa52b98ce6dcf8916dd0d7136882dab4b1d11cf203be1586ff2cd9fb8e',
              memberCount: 1,
              uncompressedByteLength: 4253,
            },
          ],
        },
      },
    });
    expect(xenTro10?.preparedBundle).not.toHaveProperty('legacyLayerIdentityContract');
    expect(xenTro10?.preparedBundle?.fullTierShards?.shards).toHaveLength(14);
  });

  it('pins agis1 to the exact verified prepared publication', () => {
    const agis1 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'agis1');

    expect(agis1).toMatchObject({
      id: 'agis1',
      provenance: { datasetId: 'GCF_034140825.1' },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/fa/fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
          sha256: 'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
          byteLength: 67186,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/42/42149e89e23d6682575963d8e14511e82762d97a1b5e86742b515e67ef211952',
          sha256: '42149e89e23d6682575963d8e14511e82762d97a1b5e86742b515e67ef211952',
          byteLength: 3928064,
          bundleManifestSha256: 'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
          bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
          tiers: ['shell', 'view'],
          rosterSha256: '7ec0c2fbf13f12340f026630e7477fb6a4cb98f9afd3a076f2ce4ecb9136bd04',
          memberCount: 35,
          uncompressedByteLength: 22297401,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: 'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
          bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
          tiers: ['detail', 'search'],
          rosterSha256: '621b3af797276b1df666dbad6ace11d7157a8c335c41dbd7ef010b982f4811cc',
          memberCount: 99,
          individualObjectIds: [
            'scene-payload-light-373fae88f27f0aa9a4a2',
            'annotation-search-payload',
            'protein-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/95/952b0a8b4e446af3f8342cd09e7215216831f660b250f1b6bf418c718b180f83',
              sha256: '952b0a8b4e446af3f8342cd09e7215216831f660b250f1b6bf418c718b180f83',
              byteLength: 17062102,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 0,
              shardCount: 9,
              rosterSha256: 'f44ad65ee5d5ac658e9b34488b27e33fa7a7fafe2b39b2f4390ec0e94a30bafe',
              memberCount: 19,
              uncompressedByteLength: 27061902,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/22/22496cd4fe9a650ebb09cb078e5ceb613036d72a20f8248f65c415980a9fc58e',
              sha256: '22496cd4fe9a650ebb09cb078e5ceb613036d72a20f8248f65c415980a9fc58e',
              byteLength: 19567329,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 1,
              shardCount: 9,
              rosterSha256: 'd3477409719007a62779dfb5f0409df1ead8e2c11e00cdc5b56dc641faef2879',
              memberCount: 12,
              uncompressedByteLength: 25770946,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/f7/f77fc4e998b49353850451390e7563df2c1b4b0d470510153010cbec1a048542',
              sha256: 'f77fc4e998b49353850451390e7563df2c1b4b0d470510153010cbec1a048542',
              byteLength: 23612162,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 2,
              shardCount: 9,
              rosterSha256: '56c15da4d388723868e9c86504f18303564068d27128d995f55e6bbeda234fd2',
              memberCount: 11,
              uncompressedByteLength: 29054096,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/eb/eb9973624991feb5b65a26a4d8f2a0b48be32da00fe0d8c2f9be3f5478745723',
              sha256: 'eb9973624991feb5b65a26a4d8f2a0b48be32da00fe0d8c2f9be3f5478745723',
              byteLength: 14725040,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 3,
              shardCount: 9,
              rosterSha256: '4f1119bd8ab161cee844fb4ee7d6cc2b5c0765a5ecb531ad52a9bab535d75fd9',
              memberCount: 7,
              uncompressedByteLength: 24756327,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/76/76b2cf666612dfec41791d12207902c20d163766cb127ee8d8aeefbcbed8a823',
              sha256: '76b2cf666612dfec41791d12207902c20d163766cb127ee8d8aeefbcbed8a823',
              byteLength: 24454794,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 4,
              shardCount: 9,
              rosterSha256: 'b61367d886acf09973d3c9e9e46d407f937595def55ce92c6020d3b1384bd3af',
              memberCount: 12,
              uncompressedByteLength: 32023712,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/bc/bce1eef45f3113fd813fa6f70f8c6cdaa45538aa5b3047fa265d61163f3c0731',
              sha256: 'bce1eef45f3113fd813fa6f70f8c6cdaa45538aa5b3047fa265d61163f3c0731',
              byteLength: 22639244,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 5,
              shardCount: 9,
              rosterSha256: '71fe4bc5e66179f73a372ebcefaa46bb781e0943f77237f4a706e5b683fcccd9',
              memberCount: 12,
              uncompressedByteLength: 29579546,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/6e/6e147ff989fe60baee2e18fed68debf1f36f6830369e82a8bcee6796444ff447',
              sha256: '6e147ff989fe60baee2e18fed68debf1f36f6830369e82a8bcee6796444ff447',
              byteLength: 19262462,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 6,
              shardCount: 9,
              rosterSha256: 'b47aa3b8cf3f5065a4d487a54f096f52ce5b9a01fc50d3e93eb5461a536cdfaa',
              memberCount: 13,
              uncompressedByteLength: 23809809,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/0e/0ea5d91959232974d39b1cc33b0cf058c03defcb54d9e08a9c482c75748fc823',
              sha256: '0ea5d91959232974d39b1cc33b0cf058c03defcb54d9e08a9c482c75748fc823',
              byteLength: 1879742,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 7,
              shardCount: 9,
              rosterSha256: '83e3676da0fe6cd2e8c7a5ee319e2568d5e363c447ee790196e9a53c0676d1b0',
              memberCount: 9,
              uncompressedByteLength: 16017311,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/d9/d9dfc8636e3fd86b1a45894675514bbac9a47bad687d64b15d4ecdeb8ac4f8cc',
              sha256: 'd9dfc8636e3fd86b1a45894675514bbac9a47bad687d64b15d4ecdeb8ac4f8cc',
              byteLength: 1779,
              bundleManifestSha256:
                'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
              bundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
              shardIndex: 8,
              shardCount: 9,
              rosterSha256: '116b4463ca926c893da10eb47616f96f8237a2bc02aa74eb566cd16b42e9fb7f',
              memberCount: 1,
              uncompressedByteLength: 4288,
            },
          ],
        },
      },
    });
    expect(agis1?.preparedBundle).not.toHaveProperty('legacyLayerIdentityContract');
    expect(agis1?.preparedBundle?.fullTierShards?.shards).toHaveLength(9);
  });

  it('pins zmB73v5 to the exact verified prepared publication', () => {
    const zmB73v5 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'zmB73v5');

    expect(zmB73v5).toMatchObject({
      id: 'zmB73v5',
      provenance: { datasetId: 'GCF_902167145.1' },
      preparedBundle: {
        manifest: {
          relativePath:
            'objects/sha256/e3/e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
          sha256: 'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
          byteLength: 72165,
        },
        firstViewPack: {
          format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
          relativePath:
            'objects/sha256/90/906ef45b2ea55b80aed3d715f4cce8f4ded1e515dbc709d98f73ac51db0421df',
          sha256: '906ef45b2ea55b80aed3d715f4cce8f4ded1e515dbc709d98f73ac51db0421df',
          byteLength: 6021221,
          bundleManifestSha256: 'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
          bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
          tiers: ['shell', 'view'],
          rosterSha256: '8c258b0d773d151b5ba1a856b6709440a8910a320ff922b2eb81a78856b417bf',
          memberCount: 44,
          uncompressedByteLength: 37992556,
        },
        fullTierShards: {
          contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
          bundleManifestSha256: 'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
          bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
          tiers: ['detail', 'search'],
          rosterSha256: '0491fe65854a2c8694aa90f3a12fe96ecc615157d965693686256b30bd0b6a6a',
          memberCount: 93,
          individualObjectIds: [
            'chr1-fasta',
            'chr10-fasta',
            'chr2-fasta',
            'chr3-fasta',
            'chr4-fasta',
            'chr5-fasta',
            'chr6-fasta',
            'chr7-fasta',
            'chr8-fasta',
            'chr9-fasta',
            'scene-payload-light-e5510f880e1aabf6a63d',
            'annotation-search-payload',
            'protein-search-payload',
          ],
          shards: [
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/7d/7d009e8a0d134b66175199a18ce668bdbf76b06e7d0743e1d57f8b92bee1651c',
              sha256: '7d009e8a0d134b66175199a18ce668bdbf76b06e7d0743e1d57f8b92bee1651c',
              byteLength: 1266782,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 0,
              shardCount: 13,
              rosterSha256: 'a51c9e6788a9c3e596e703a005188fea35a81226f0cd0df98ca5976ea02b63dd',
              memberCount: 16,
              uncompressedByteLength: 12757884,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/36/36882dde95b7caa4d51e23ecb2639acc3f192d72e9e4ec9130f23fc885600c61',
              sha256: '36882dde95b7caa4d51e23ecb2639acc3f192d72e9e4ec9130f23fc885600c61',
              byteLength: 3499753,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 1,
              shardCount: 13,
              rosterSha256: 'b1472ba4dac0b8a32550b9b9b71751e9603dc8cc4d04e382d73723f61b0df078',
              memberCount: 5,
              uncompressedByteLength: 8322789,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/6f/6f1b9bbab8ffdf54894f53d060148d4cb4b8c46a8f62798839c43a0488c6dcf5',
              sha256: '6f1b9bbab8ffdf54894f53d060148d4cb4b8c46a8f62798839c43a0488c6dcf5',
              byteLength: 2281793,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 2,
              shardCount: 13,
              rosterSha256: '3547645526f1bc3c751d99a872ac7b9efec340857a22333d4bce27228bb5ec09',
              memberCount: 5,
              uncompressedByteLength: 10399489,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/42/42d7c1d108e4a5659cd18ee56b8ee3f226115ae252cda62a4726df7a28b30df6',
              sha256: '42d7c1d108e4a5659cd18ee56b8ee3f226115ae252cda62a4726df7a28b30df6',
              byteLength: 3119846,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 3,
              shardCount: 13,
              rosterSha256: '763186113c6edc800a8348f9d72b1139692a273ac2b14017378f5ec83a3bd24a',
              memberCount: 5,
              uncompressedByteLength: 10578228,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/9d/9d5174267dfbf76266504a4ff007f9c2b84fa344b4f1991bfea41e8de4c85105',
              sha256: '9d5174267dfbf76266504a4ff007f9c2b84fa344b4f1991bfea41e8de4c85105',
              byteLength: 2952883,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 4,
              shardCount: 13,
              rosterSha256: '899fffdd9393dbe081a7d72cc558e51eda77249cdc8310a1a33ada1752d94323',
              memberCount: 5,
              uncompressedByteLength: 10156347,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/95/958e5d512da00684ff346b82da0dc9cb31f4f2baba29cfd0bbb0d61345393fc3',
              sha256: '958e5d512da00684ff346b82da0dc9cb31f4f2baba29cfd0bbb0d61345393fc3',
              byteLength: 2931700,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 5,
              shardCount: 13,
              rosterSha256: 'ffb8c8fdf9a87dad9f1f0b0b2aa0cbccb5680a3c9a92e3ae064dda060a78f057',
              memberCount: 5,
              uncompressedByteLength: 10858680,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/54/54e820d81fa89cdb6b42d012535f972f71219ad5cbccdd72b4c32475f14dbbff',
              sha256: '54e820d81fa89cdb6b42d012535f972f71219ad5cbccdd72b4c32475f14dbbff',
              byteLength: 3004341,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 6,
              shardCount: 13,
              rosterSha256: '6e48463775c6ed3168877b8ffb720d8a343ecb97e2c9b960b2b7fdc49765be9b',
              memberCount: 5,
              uncompressedByteLength: 9506000,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/ae/ae245e906da3d41d1f59ea3c6e512da366ac83eeb4919c8e9c92a308d30b4221',
              sha256: 'ae245e906da3d41d1f59ea3c6e512da366ac83eeb4919c8e9c92a308d30b4221',
              byteLength: 2385104,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 7,
              shardCount: 13,
              rosterSha256: '172ecd80c6dc93e3fe3667d89084d92c398abee8a7e785e2443391c940eb2b9a',
              memberCount: 5,
              uncompressedByteLength: 8129035,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/86/86bd306a0874fb273455d126c54bda3eb544f3bdd05e6f9be1449a8380628ff5',
              sha256: '86bd306a0874fb273455d126c54bda3eb544f3bdd05e6f9be1449a8380628ff5',
              byteLength: 2321320,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 8,
              shardCount: 13,
              rosterSha256: 'aa2a4040fb1ba7a1eed4ab5ff9a3b2408c72b3b3044ba67268e8faaae743ae25',
              memberCount: 5,
              uncompressedByteLength: 8397882,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/0c/0cff5c01130715b7c8c3f8588cf13d60b35ca58362d0044c6cb671a7a65fde43',
              sha256: '0cff5c01130715b7c8c3f8588cf13d60b35ca58362d0044c6cb671a7a65fde43',
              byteLength: 2352545,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 9,
              shardCount: 13,
              rosterSha256: '46cd3347c536dace44ae6ee26258d2a39b088ef60615e623ba1ffe5008d49276',
              memberCount: 5,
              uncompressedByteLength: 7790730,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/11/11a4e5add9e89fe641b908af318b393ed65ef777a355c46ad6dafdffe023d2e8',
              sha256: '11a4e5add9e89fe641b908af318b393ed65ef777a355c46ad6dafdffe023d2e8',
              byteLength: 3752146,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 10,
              shardCount: 13,
              rosterSha256: '95133272863eab3cb6a8e5dd373d0699764c0faf4665afa79995e50461b0ac8b',
              memberCount: 13,
              uncompressedByteLength: 17818588,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/79/79548758d37df2691ed4f88f2a996a806323114e0f4427781de3c8f16c13bc98',
              sha256: '79548758d37df2691ed4f88f2a996a806323114e0f4427781de3c8f16c13bc98',
              byteLength: 1390410,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 11,
              shardCount: 13,
              rosterSha256: 'b7aa59f0bc92636c60318c7d85360649ca68aa756fb28ad2e35cafd960c627b8',
              memberCount: 5,
              uncompressedByteLength: 10681421,
            },
            {
              format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
              relativePath:
                'objects/sha256/44/44d11c752e78b567bff9df1188e33063e98ec9be4f757868b13711d6f5644c24',
              sha256: '44d11c752e78b567bff9df1188e33063e98ec9be4f757868b13711d6f5644c24',
              byteLength: 1749,
              bundleManifestSha256:
                'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
              bundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
              shardIndex: 12,
              shardCount: 13,
              rosterSha256: '1a313c40a5272317e2728fce4d83e5da7bfa6cdf0f65a03d9fe6604cf153f01a',
              memberCount: 1,
              uncompressedByteLength: 4177,
            },
          ],
        },
      },
    });
    expect(zmB73v5?.preparedBundle).not.toHaveProperty('legacyLayerIdentityContract');
    expect(zmB73v5?.preparedBundle?.fullTierShards?.shards).toHaveLength(13);
  });

  it('stages unprepared immutable primary-chromosome sources without exposing them at runtime', () => {
    const expectedStagedReferences = [
      {
        id: 'mm39',
        name: 'GRCm39 (mouse)',
        organism: 'Mus musculus',
        taxId: 10_090,
        assembly: 'GRCm39',
        description:
          'Mouse GRCm39 reference — primary chromosomes with searchable NCBI RefSeq annotations.',
        sources: {
          fasta: {
            relativePath:
              'mm39/GCF_000001635.27/3185b185d83de72a/GCF_000001635.27_GRCm39_primary.fna.gz',
            sha256: '3185b185d83de72aacab15b247ed5734982b657fc0be8b26fc3c14fed578f1fa',
            byteLength: 831_488_844,
          },
          annotations: {
            relativePath:
              'mm39/GCF_000001635.27/0f0a0e4aa69a22dc/GCF_000001635.27_GRCm39_primary.gff3.gz',
            sha256: '0f0a0e4aa69a22dc4bae0d4d1b5d224c0a439c3fcc705869fae76ad681230a35',
            byteLength: 43_644_682,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_000001635.27',
          datasetVersion: 'GCF_000001635.27-RS_2024_02',
        },
      },
      {
        id: 'grcz12tu',
        name: 'GRCz12tu (zebrafish)',
        organism: 'Danio rerio',
        taxId: 7_955,
        assembly: 'GRCz12tu',
        description:
          'Zebrafish GRCz12tu reference — primary chromosomes with searchable NCBI RefSeq annotations.',
        sources: {
          fasta: {
            relativePath:
              'grcz12tu/GCF_049306965.2/c684d7b71548a141/GCF_049306965.2_GRCz12tu_primary.fna.gz',
            sha256: 'c684d7b71548a141551710c3f2edfa77f7591028a6ad2297d9e3a43b708c8982',
            byteLength: 434_953_682,
          },
          annotations: {
            relativePath:
              'grcz12tu/GCF_049306965.2/3515f63aab87a5ad/GCF_049306965.2_GRCz12tu_primary.gff3.gz',
            sha256: '3515f63aab87a5ad5b8ff6b138d2d9357d4431551501e1a5dbf29252a52e48a3',
            byteLength: 38_881_633,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_049306965.2',
          datasetVersion: 'GCF_049306965.1-RS_2025_04',
        },
      },
      {
        id: 'dm6',
        name: 'D. melanogaster (dm6)',
        organism: 'Drosophila melanogaster',
        taxId: 7_227,
        assembly: 'dm6',
        description:
          'Fruit fly dm6 reference — primary chromosomes with searchable FlyBase annotations.',
        sources: {
          fasta: {
            relativePath: 'dm6/GCF_000001215.4/e02cee38083b5fec/GCF_000001215.4_dm6_primary.fna.gz',
            sha256: 'e02cee38083b5fecf0819185f1ed236d94f6f08896db5968bddc4d7a6351e990',
            byteLength: 42_673_573,
          },
          annotations: {
            relativePath:
              'dm6/GCF_000001215.4/ae77e6aefd60c0e5/GCF_000001215.4_dm6_primary.gff3.gz',
            sha256: 'ae77e6aefd60c0e513ed77a882b587d57dc17b43d98b78a1b21a3da3f4d636dd',
            byteLength: 8_600_288,
          },
        },
        provenance: {
          provider: 'FlyBase',
          datasetId: 'GCF_000001215.4',
          datasetVersion: 'FlyBase Release 6.54',
        },
      },
      {
        id: 'xenTro10',
        name: 'X. tropicalis (xenTro10)',
        organism: 'Xenopus tropicalis',
        taxId: 8_369,
        assembly: 'UCB_Xtro_10.0',
        description:
          'Western clawed frog UCB_Xtro_10.0 reference — primary chromosomes with searchable NCBI RefSeq annotations.',
        sources: {
          fasta: {
            relativePath:
              'xenTro10/GCF_000004195.4/caeeff933dd13808/GCF_000004195.4_UCB_Xtro_10.0_primary.fna.gz',
            sha256: 'caeeff933dd138086456e9b5d774729ad9e26794b49a3527ac522fbde5f2f7cf',
            byteLength: 431_042_563,
          },
          annotations: {
            relativePath:
              'xenTro10/GCF_000004195.4/eedbc5ab1f7a4bc9/GCF_000004195.4_UCB_Xtro_10.0_primary.gff3.gz',
            sha256: 'eedbc5ab1f7a4bc980d86c0e2523a5ed29fb92005b453e1138c5eb589f8b61d0',
            byteLength: 17_445_280,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_000004195.4',
          datasetVersion: 'NCBI Annotation Release 104',
        },
      },
      {
        id: 'agis1',
        name: 'O. sativa (AGIS1.0)',
        organism: 'Oryza sativa',
        taxId: 4_530,
        assembly: 'AGIS1.0',
        description:
          'Asian rice AGIS1.0 reference — primary nuclear chromosomes with searchable NCBI RefSeq annotations.',
        sources: {
          fasta: {
            relativePath:
              'agis1/GCF_034140825.1/3c2bb9240ef89731/GCF_034140825.1_AGIS1.0_primary.fna.gz',
            sha256: '3c2bb9240ef8973144e945872b31af591dfa55c4587b128b41bea1bb3795465b',
            byteLength: 119_872_257,
          },
          annotations: {
            relativePath:
              'agis1/GCF_034140825.1/b1837ac52c65292f/GCF_034140825.1_AGIS1.0_primary.gff3.gz',
            sha256: 'b1837ac52c65292fa1c28c64ace8c05a81c54e535cf54c7fa4186a1f4695992b',
            byteLength: 11_336_814,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_034140825.1',
          datasetVersion: 'GCF_034140825.1-RS_2024_06',
        },
      },
      {
        id: 'zmB73v5',
        name: 'Z. mays B73 (NAM-5.0)',
        organism: 'Zea mays',
        taxId: 4_577,
        assembly: 'NAM-5.0',
        description:
          'Maize B73 NAM-5.0 reference — primary nuclear chromosomes with searchable NCBI RefSeq annotations.',
        sources: {
          fasta: {
            relativePath:
              'zmB73v5/GCF_902167145.1/4627fdd2b5afb5f5/GCF_902167145.1_NAM_5.0_primary.fna.gz',
            sha256: '4627fdd2b5afb5f5ee5659c2f43e983ce309e65457a9fb6ae2265e902b05dc0f',
            byteLength: 639_752_083,
          },
          annotations: {
            relativePath:
              'zmB73v5/GCF_902167145.1/40052a527b5b8bbf/GCF_902167145.1_NAM_5.0_primary.gff3.gz',
            sha256: '40052a527b5b8bbf7460a7c937521a6bdd7450b7174605b3a76731bcf2dd6d45',
            byteLength: 15_816_410,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_902167145.1',
          datasetVersion: 'GCF_902167145.1-RS_2025_02',
        },
      },
      {
        id: 't2tMmu8v2',
        name: 'T2T-MMU8v2.0 (rhesus macaque)',
        organism: 'Macaca mulatta',
        taxId: 9_544,
        assembly: 'T2T-MMU8v2.0',
        description:
          'Exact T2T-MMU8v2.0 Macaca mulatta reference — NCBI RefSeq assembled molecules with searchable annotations.',
        sources: {
          fasta: {
            relativePath: 't2tMmu8v2/GCF_049350105.2/cb667b37d58cd5b7/GCF_049350105.2_primary.fna',
            sha256: 'cb667b37d58cd5b7146c6ee081683c1c56bc9c39cdb712782a24a873f27fb7a3',
            byteLength: 3_154_061_906,
          },
          annotations: {
            relativePath: 't2tMmu8v2/GCF_049350105.2/ec5be862bba7e4d0/GCF_049350105.2_primary.gff3',
            sha256: 'ec5be862bba7e4d0749e2e57aa9d128551d8fbbc850587ce112ab565d78feb11',
            byteLength: 1_079_579_154,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_049350105.2',
          datasetVersion: 'T2T-MMU8v2.0',
        },
      },
      {
        id: 'rheMac10',
        name: 'Mmul_10 (rhesus macaque)',
        organism: 'Macaca mulatta',
        taxId: 9_544,
        assembly: 'Mmul_10',
        description:
          'Exact Mmul_10 Macaca mulatta reference — NCBI RefSeq assembled molecules with searchable annotations.',
        sources: {
          fasta: {
            relativePath: 'rheMac10/GCF_003339765.1/ee3f2e50f2e5e97e/GCF_003339765.1_primary.fna',
            sha256: 'ee3f2e50f2e5e97e06bb5b5b4268c47756d2750ee825d3ac91c11de9af2f9036',
            byteLength: 2_889_670_017,
          },
          annotations: {
            relativePath: 'rheMac10/GCF_003339765.1/48a4f1723e005378/GCF_003339765.1_primary.gff3',
            sha256: '48a4f1723e0053780fe69ffc6cfa8cc2f9e53da5b2f2dba2c007792e83f18cd7',
            byteLength: 559_605_255,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_003339765.1',
          datasetVersion: 'Mmul_10',
        },
      },
      {
        id: 'mPanTro3v21',
        name: 'NHGRI mPanTro3 v2.1 (chimpanzee)',
        organism: 'Pan troglodytes',
        taxId: 9_598,
        assembly: 'NHGRI_mPanTro3-v2.1_pri',
        description:
          'Exact NHGRI_mPanTro3-v2.1_pri Pan troglodytes reference — NCBI RefSeq assembled molecules with searchable annotations.',
        sources: {
          fasta: {
            relativePath:
              'mPanTro3v21/GCF_028858775.2/01376b85cfbe6c4f/GCF_028858775.2_primary.fna',
            sha256: '01376b85cfbe6c4f569078095a61a793ceacb928a4d6b797e4c53c7c117a0f6e',
            byteLength: 3_217_481_210,
          },
          annotations: {
            relativePath:
              'mPanTro3v21/GCF_028858775.2/aaba8ba29d2081a8/GCF_028858775.2_primary.gff3',
            sha256: 'aaba8ba29d2081a8ccdc170d1196e0c33023fd4072456e3c1a530c318d8d5c89',
            byteLength: 1_049_847_869,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_028858775.2',
          datasetVersion: 'NHGRI_mPanTro3-v2.1_pri',
        },
      },
      {
        id: 'mGorGor1v21',
        name: 'NHGRI mGorGor1 v2.1 (gorilla)',
        organism: 'Gorilla gorilla gorilla',
        taxId: 9_595,
        assembly: 'NHGRI_mGorGor1-v2.1_pri',
        description:
          'Exact NHGRI_mGorGor1-v2.1_pri Gorilla gorilla gorilla reference — NCBI RefSeq assembled molecules with searchable annotations.',
        sources: {
          fasta: {
            relativePath:
              'mGorGor1v21/GCF_029281585.2/b828375c433f77c0/GCF_029281585.2_primary.fna',
            sha256: 'b828375c433f77c0292361c73f3dd31e98e5cd804663b3c162245a6325213508',
            byteLength: 3_590_176_889,
          },
          annotations: {
            relativePath:
              'mGorGor1v21/GCF_029281585.2/93332a5c08ea6635/GCF_029281585.2_primary.gff3',
            sha256: '93332a5c08ea6635a87e8f4617ea5c280fdef86192b9ea9fe3b938183f620eac',
            byteLength: 692_638_627,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_029281585.2',
          datasetVersion: 'NHGRI_mGorGor1-v2.1_pri',
        },
      },
      {
        id: 'mOryCun11',
        name: 'mOryCun1.1 (rabbit)',
        organism: 'Oryctolagus cuniculus',
        taxId: 9_986,
        assembly: 'mOryCun1.1',
        description:
          'Exact mOryCun1.1 Oryctolagus cuniculus reference — NCBI RefSeq assembled molecules with searchable annotations.',
        sources: {
          fasta: {
            relativePath: 'mOryCun11/GCF_964237555.1/f24f1b8720007327/GCF_964237555.1_primary.fna',
            sha256: 'f24f1b87200073273531c26c0fd6d201697b8cf343419b6d4893f94f5762f0e2',
            byteLength: 2_777_603_833,
          },
          annotations: {
            relativePath: 'mOryCun11/GCF_964237555.1/dc8580a3222cfde3/GCF_964237555.1_primary.gff3',
            sha256: 'dc8580a3222cfde39e4fe4e73ad7e2f008c1567b9e6f28b41bcd178fc34c40e5',
            byteLength: 694_963_984,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_964237555.1',
          datasetVersion: 'mOryCun1.1',
        },
      },
      {
        id: 'oarRambouilletV3',
        name: 'ARS-UI Rambouillet v3.0 (sheep)',
        organism: 'Ovis aries',
        taxId: 9_940,
        assembly: 'ARS-UI_Ramb_v3.0',
        description:
          'Exact ARS-UI_Ramb_v3.0 Ovis aries reference — NCBI RefSeq assembled molecules with searchable annotations.',
        sources: {
          fasta: {
            relativePath:
              'oarRambouilletV3/GCF_016772045.2/4676028b1a68b41e/GCF_016772045.2_primary.fna',
            sha256: '4676028b1a68b41e56dd6e525560805d3db320f54f783a94ee8898db30242f3e',
            byteLength: 2_674_606_512,
          },
          annotations: {
            relativePath:
              'oarRambouilletV3/GCF_016772045.2/456ff3f9116d3551/GCF_016772045.2_primary.gff3',
            sha256: '456ff3f9116d3551796cb68a1af4cf77d7061735b93f01fbef4d62e41b2edda4',
            byteLength: 732_658_886,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_016772045.2',
          datasetVersion: 'ARS-UI_Ramb_v3.0',
        },
      },
      {
        id: 'equCabTbT2t',
        name: 'TB-T2T (horse)',
        organism: 'Equus caballus',
        taxId: 9_796,
        assembly: 'TB-T2T',
        description:
          'Exact TB-T2T Equus caballus reference — NCBI RefSeq assembled molecules with searchable annotations.',
        sources: {
          fasta: {
            relativePath:
              'equCabTbT2t/GCF_041296265.1/24482aea51b7584e/GCF_041296265.1_primary.fna',
            sha256: '24482aea51b7584e00c25511d459fd070cb66a43ce14428a0a69405a6526d941',
            byteLength: 2_717_135_912,
          },
          annotations: {
            relativePath:
              'equCabTbT2t/GCF_041296265.1/db3240f486c8379e/GCF_041296265.1_primary.gff3',
            sha256: 'db3240f486c8379e85dbdcb20c5871edccf51d84b4f5bb6bb68b3031a2ef0a92',
            byteLength: 963_797_859,
          },
        },
        provenance: {
          provider: 'NCBI RefSeq',
          datasetId: 'GCF_041296265.1',
          datasetVersion: 'TB-T2T',
        },
      },
    ] as const;
    const stagedReferences = HOSTED_REFERENCE_BUILD_CATALOG_V1.filter(
      ({ preparedBundle }) => preparedBundle === undefined
    );
    const expectedSourcePublishedIds: string[] = [];

    expect(stagedReferences.map(({ id }) => id)).toEqual(expectedSourcePublishedIds);
    for (const expectedReference of expectedStagedReferences) {
      const preparedReference = HOSTED_REFERENCE_CATALOG_V1.find(
        ({ id }) => id === expectedReference.id
      );
      expect(preparedReference).toMatchObject(expectedReference);
      expect(preparedReference?.preparedBundle).toBeDefined();
      expect(preparedReference?.provenance).toMatchObject({
        sourceUrl: `https://www.ncbi.nlm.nih.gov/datasets/genome/${expectedReference.provenance.datasetId}/`,
        license: 'NCBI public-domain data',
      });
    }
    expect(
      stagedReferences.every(
        ({ provenance, sources, contigs }) =>
          ((provenance.provider === 'NCBI RefSeq' &&
            provenance.sourceUrl ===
              `https://www.ncbi.nlm.nih.gov/datasets/genome/${provenance.datasetId}/` &&
            provenance.license === 'NCBI public-domain data') ||
            (provenance.provider === 'UCSC Genome Browser' &&
              provenance.sourceUrl ===
                `https://hgdownload.soe.ucsc.edu/goldenPath/${provenance.datasetId}/bigZips/` &&
              provenance.license ===
                'UCSC Genome Browser data are freely available for public use') ||
            (provenance.provider === 'NCBI GenBank + Figshare' &&
              provenance.datasetId === 'GCA_034376525.1; 10.6084/m9.figshare.25441192.v1' &&
              provenance.sourceUrl ===
                'https://figshare.com/articles/dataset/Nicotiana_benthamiana_KLAB_NbKLAB_Genome_assembly_and_annotation/25441192' &&
              provenance.license === 'NCBI public-domain data; CC BY 4.0')) &&
          /^[0-9a-f]{64}$/u.test(sources.fasta.sha256) &&
          /^[0-9a-f]{64}$/u.test(sources.annotations.sha256) &&
          contigs.length > 0
      )
    ).toBe(true);

    expect(HOSTED_REFERENCE_CATALOG_V1.map(({ id }) => id)).toEqual([
      'grch38',
      'sacCer3',
      'ce11',
      'mm39',
      'grcz12tu',
      'dm6',
      'xenTro10',
      'tair10',
      'agis1',
      'zmB73v5',
      't2tMmu8v2',
      'rheMac10',
      'mPanTro3v21',
      'mGorGor1v21',
      'mOryCun11',
      'oarRambouilletV3',
      'equCabTbT2t',
      'hs1',
      'rn8',
      'rn7',
      'danRer11',
      'pombeAsm294v3',
      'xenLae10',
      'grcg7b',
      'canFam4',
      'hg19',
      'mm10',
      'susScrHxylV2',
      'arsUcd2',
      'criGriPicrh1',
      'panTro6',
      'medakaHdRr31',
      'grcz12ab',
      'galGal6',
      'canFam6',
      'canFam3',
      'susScr11',
      'bosTau9',
      'pomBase',
      'tomatoSlmR21',
      'irgsp1',
      'soybeanV4',
      'ntK326',
      'kphaffiiGs115',
      'kphaffiiCbs7435',
      'candidaSC5314',
      'anidulansFgscA4',
      'pfalciparum3d7',
      'agambiaeF1',
      'sarsCov2WuhanHu1',
      't2tMfa8v11',
      'sbicolorNcbiv3',
      'wheatRefseqV21',
      'ecoliK12Mg1655',
      'ecoliBl21De3',
      'bacillus168',
      'pputidaKt2440',
      'cglutamicumAtcc13032',
      'scoelicolorA32',
      'mtbH37Rv',
      'paeruginosaPao1',
      'saureusNctc8325',
      'salmonellaLt2',
      'saureusUsa300Fpr3757',
      'nibenKlab',
    ]);
  });

  it('projects only renderer-safe catalog metadata', () => {
    const definitionWithPreparedBundle = {
      ...HOSTED_REFERENCE_CATALOG_V1[0],
      preparedBundle: {
        manifest: {
          relativePath:
            'prepared/grch38/objects/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sha256: 'a'.repeat(64),
          byteLength: 12_345,
        },
      },
    };
    const projected = hostedReferenceCatalogEntryV1(definitionWithPreparedBundle);

    expect(projected).toEqual({
      id: 'grch38',
      name: 'GRCh38 (human)',
      organism: 'Homo sapiens',
      assembly: 'GRCh38.p14',
      description:
        'Human reference — full primary karyotype (chr1-22, X, Y) with searchable NCBI RefSeq annotations.',
      cacheStatus: 'not-cached',
      lengthBp: 3_088_269_832,
      contigCount: 24,
      downloadBytes: 1_035_705_333,
      provider: 'NCBI RefSeq',
      datasetVersion: 'GRCh38.p14',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/',
    });
    expect(projected).not.toHaveProperty('sources');
    expect(projected).not.toHaveProperty('preparedBundle');
    expect(projected).not.toHaveProperty('provenance.sourceUrl');
  });
});
