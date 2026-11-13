import type { HostedReferenceCatalogEntryV1 } from '../../shared/reference-assets-ipc';
import { HOSTED_REFERENCE_ROLLOUT_CATALOG_V1 } from './hosted-reference-rollout-catalog';
import type {
  HostedReferenceCatalogDefinitionV1,
  HostedReferencePreparedCatalogDefinitionV1,
} from './hosted-reference-catalog-types';
import {
  HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1,
  assertHostedReferenceSemanticCoverageV1,
} from './reference-semantic-source-catalog';

export type {
  HostedReferenceCatalogDefinitionV1,
  HostedReferenceContigV1,
  HostedReferenceFirstViewPackAssetV1,
  HostedReferenceFullTierShardAssetV1,
  HostedReferenceFullTierShardsAssetV1,
  HostedReferencePreparedBundleAssetV1,
  HostedReferencePreparedCatalogDefinitionV1,
  HostedReferenceSourceAssetV1,
} from './hosted-reference-catalog-types';
import { GRCH38_PREPARED_BUNDLE_V1 } from './hosted-reference-prepared-publications-grch38';

const GRCH38_FASTA_SHA256 = 'c798efbf2cb51c6d01b6a759e6c3cf5b48d3b58b95f7ea2fcd0f3e03cde5ae61';
const GRCH38_GFF3_SHA256 = '6f6da659257e957387360de699ee3f45206ada3edd5fc233399773fc98db7d16';

const GRCH38_PRIMARY_CONTIGS = [
  ['chr1', 248_956_422, 'NC_000001.11'],
  ['chr2', 242_193_529, 'NC_000002.12'],
  ['chr3', 198_295_559, 'NC_000003.12'],
  ['chr4', 190_214_555, 'NC_000004.12'],
  ['chr5', 181_538_259, 'NC_000005.10'],
  ['chr6', 170_805_979, 'NC_000006.12'],
  ['chr7', 159_345_973, 'NC_000007.14'],
  ['chr8', 145_138_636, 'NC_000008.11'],
  ['chr9', 138_394_717, 'NC_000009.12'],
  ['chr10', 133_797_422, 'NC_000010.11'],
  ['chr11', 135_086_622, 'NC_000011.10'],
  ['chr12', 133_275_309, 'NC_000012.12'],
  ['chr13', 114_364_328, 'NC_000013.11'],
  ['chr14', 107_043_718, 'NC_000014.9'],
  ['chr15', 101_991_189, 'NC_000015.10'],
  ['chr16', 90_338_345, 'NC_000016.10'],
  ['chr17', 83_257_441, 'NC_000017.11'],
  ['chr18', 80_373_285, 'NC_000018.10'],
  ['chr19', 58_617_616, 'NC_000019.10'],
  ['chr20', 64_444_167, 'NC_000020.11'],
  ['chr21', 46_709_983, 'NC_000021.9'],
  ['chr22', 50_818_468, 'NC_000022.11'],
  ['chrX', 156_040_895, 'NC_000023.11'],
  ['chrY', 57_227_415, 'NC_000024.10'],
] as const;

const SACCER3_CONTIGS = [
  ['chrI', 'I', 230_218, 'NC_001133.9', 'BK006935.2'],
  ['chrII', 'II', 813_184, 'NC_001134.8', 'BK006936.2'],
  ['chrIII', 'III', 316_620, 'NC_001135.5', 'BK006937.2'],
  ['chrIV', 'IV', 1_531_933, 'NC_001136.10', 'BK006938.2'],
  ['chrV', 'V', 576_874, 'NC_001137.3', 'BK006939.2'],
  ['chrVI', 'VI', 270_161, 'NC_001138.5', 'BK006940.2'],
  ['chrVII', 'VII', 1_090_940, 'NC_001139.9', 'BK006941.2'],
  ['chrVIII', 'VIII', 562_643, 'NC_001140.6', 'BK006934.2'],
  ['chrIX', 'IX', 439_888, 'NC_001141.2', 'BK006942.2'],
  ['chrX', 'X', 745_751, 'NC_001142.9', 'BK006943.2'],
  ['chrXI', 'XI', 666_816, 'NC_001143.9', 'BK006944.2'],
  ['chrXII', 'XII', 1_078_177, 'NC_001144.5', 'BK006945.2'],
  ['chrXIII', 'XIII', 924_431, 'NC_001145.3', 'BK006946.2'],
  ['chrXIV', 'XIV', 784_333, 'NC_001146.8', 'BK006947.3'],
  ['chrXV', 'XV', 1_091_291, 'NC_001147.6', 'BK006948.2'],
  ['chrXVI', 'XVI', 948_066, 'NC_001148.4', 'BK006949.2'],
  ['chrM', 'MT', 85_779, 'NC_001224.1', 'KP263414.1'],
] as const;

const CE11_CONTIGS = [
  ['chrI', 'I', 15_072_434, 'NC_003279.8', 'BX284601.5'],
  ['chrII', 'II', 15_279_421, 'NC_003280.10', 'BX284602.5'],
  ['chrIII', 'III', 13_783_801, 'NC_003281.10', 'BX284603.4'],
  ['chrIV', 'IV', 17_493_829, 'NC_003282.8', 'BX284604.4'],
  ['chrV', 'V', 20_924_180, 'NC_003283.11', 'BX284605.5'],
  ['chrX', 'X', 17_718_942, 'NC_003284.9', 'BX284606.5'],
  ['chrM', 'MT', 13_794, 'NC_001328.1', 'X54252.1'],
] as const;

export const DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL =
  'https://references.dnaforge.com/reference-genomes/v1/';
export const DNAFORGE_HOSTED_REFERENCE_BASE_URL_ENV = 'DNAFORGE_HOSTED_REFERENCE_BASE_URL';

const HOSTED_REFERENCE_BASE_CATALOG_V1: ReadonlyArray<HostedReferencePreparedCatalogDefinitionV1> =
  Object.freeze([
    Object.freeze({
      id: 'grch38',
      name: 'GRCh38 (human)',
      organism: 'Homo sapiens',
      taxId: 9_606,
      assembly: 'GRCh38.p14',
      description:
        'Human reference — full primary karyotype (chr1-22, X, Y) with searchable NCBI RefSeq annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'grch38/GCF_000001405.40/c798efbf2cb51c6d/GRCh38.p14.primary-assembly.fa.gz',
          sha256: GRCH38_FASTA_SHA256,
          byteLength: 934_116_592,
        }),
        annotations: Object.freeze({
          relativePath:
            'grch38/GCF_000001405.40/6f6da659257e9573/GRCh38.p14.primary-assembly.gff3.gz',
          sha256: GRCH38_GFF3_SHA256,
          byteLength: 101_588_741,
        }),
      }),
      preparedBundle: GRCH38_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_000001405.40',
        datasetVersion: 'GRCh38.p14',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: Object.freeze(
        GRCH38_PRIMARY_CONTIGS.map(([chrom, lengthBp, refseq]) =>
          Object.freeze({
            chrom,
            sourceSeqId: chrom,
            displayName: chrom,
            lengthBp,
            role: 'assembled-molecule' as const,
            aliases: Object.freeze({
              refseq,
              ucsc: chrom,
              ensembl: chrom.slice(3),
            }),
            circular: false,
            cytobandId: chrom,
          })
        )
      ),
    }),
    Object.freeze({
      id: 'sacCer3',
      name: 'Saccharomyces cerevisiae (sacCer3)',
      organism: 'Saccharomyces cerevisiae S288C',
      taxId: 559_292,
      assembly: 'GCF_000146045.2',
      description: 'Saccharomyces cerevisiae S288C reference assembly R64-1-1',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 'sacCer3/GCF_000146045.2/fe42735d3e6242f/GCF_000146045.2_R64_genomic.fna',
          sha256: 'fe42735d3e6242f8c40b457a232940e34ef15eb4502717e54a34ed118face4c1',
          byteLength: 12_310_392,
        }),
        annotations: Object.freeze({
          relativePath: 'sacCer3/GCF_000146045.2/228ea6918fc034e8/genomic.gff',
          sha256: '228ea6918fc034e80a34f87d30729c0a8caeb019861baef7d14878324a0d7b8c',
          byteLength: 12_464_547,
        }),
      }),
      preparedBundle: Object.freeze({
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
      } as const),
      provenance: Object.freeze({
        provider: 'SGD',
        datasetId: 'GCF_000146045.2',
        datasetVersion: 'SGD R64-5-1',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000146045.2/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: Object.freeze(
        SACCER3_CONTIGS.map(([chrom, displayName, lengthBp, refseq, genbank]) =>
          Object.freeze({
            chrom,
            sourceSeqId: refseq,
            displayName,
            lengthBp,
            role: chrom === 'chrM' ? ('mitochondrion' as const) : ('assembled-molecule' as const),
            aliases: Object.freeze({
              refseq,
              genbank,
              ucsc: chrom,
              ensembl: displayName,
            }),
            circular: chrom === 'chrM',
          })
        )
      ),
    }),
    Object.freeze({
      id: 'ce11',
      name: 'C. elegans (ce11 / WBcel235)',
      organism: 'Caenorhabditis elegans',
      taxId: 6_239,
      assembly: 'GCF_000002985.6',
      description:
        'Caenorhabditis elegans WBcel235 reference assembly (IGV ce11), with WormBase annotations distributed by NCBI.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'ce11/GCF_000002985.6/739d1fb774ef9f5a/GCF_000002985.6_WBcel235_genomic.fna',
          sha256: '739d1fb774ef9f5a2de12fd16de3e559201d00d69502b7013d820584d9369220',
          byteLength: 101_540_352,
        }),
        annotations: Object.freeze({
          relativePath: 'ce11/GCF_000002985.6/b6296b398ce09b94/genomic.gff',
          sha256: 'b6296b398ce09b944696d7519d5013886e3ee2172760a6a6849774afc116334d',
          byteLength: 174_184_304,
        }),
      }),
      preparedBundle: Object.freeze({
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
      } as const),
      provenance: Object.freeze({
        provider: 'WormBase',
        datasetId: 'GCF_000002985.6',
        datasetVersion: 'WormBase WS298',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000002985.6/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: Object.freeze(
        CE11_CONTIGS.map(([chrom, displayName, lengthBp, refseq, genbank]) =>
          Object.freeze({
            chrom,
            sourceSeqId: refseq,
            displayName,
            lengthBp,
            role: chrom === 'chrM' ? ('mitochondrion' as const) : ('assembled-molecule' as const),
            aliases: Object.freeze({
              refseq,
              genbank,
              ...(chrom === 'chrM' ? { ucsc: chrom } : {}),
              ensembl: displayName,
            }),
            circular: chrom === 'chrM',
          })
        )
      ),
    }),
  ]);

export const HOSTED_REFERENCE_CATALOG_V1: ReadonlyArray<HostedReferencePreparedCatalogDefinitionV1> =
  Object.freeze([...HOSTED_REFERENCE_BASE_CATALOG_V1, ...HOSTED_REFERENCE_ROLLOUT_CATALOG_V1]);

assertHostedReferenceSemanticCoverageV1(
  HOSTED_REFERENCE_CATALOG_V1,
  HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1
);

export function hostedReferenceCatalogEntryV1(
  definition: HostedReferenceCatalogDefinitionV1,
  cacheStatus: HostedReferenceCatalogEntryV1['cacheStatus'] = 'not-cached'
): HostedReferenceCatalogEntryV1 {
  return {
    id: definition.id,
    name: definition.name,
    organism: definition.organism,
    assembly: definition.assembly,
    description: definition.description,
    cacheStatus,
    lengthBp: definition.contigs.reduce((sum, contig) => sum + contig.lengthBp, 0),
    contigCount: definition.contigs.length,
    downloadBytes: definition.sources.fasta.byteLength + definition.sources.annotations.byteLength,
    provider: definition.provenance.provider,
    datasetVersion: definition.provenance.datasetVersion,
    sourceUrl: definition.provenance.sourceUrl,
  };
}
