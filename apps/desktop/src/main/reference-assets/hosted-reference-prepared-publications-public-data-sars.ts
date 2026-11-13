import type { HostedReferencePreparedBundleAssetV1 } from './hosted-reference-prepared-bundle-contract';

export const SARS_COV2_WUHAN_HU1_PREPARED_BUNDLE_V1 = Object.freeze({
  manifest: {
    relativePath:
      'objects/sha256/78/7830daffeac153a5c62327566c8e8772537a9d23bf06f25549a12b63c4bc8aab',
    sha256: '7830daffeac153a5c62327566c8e8772537a9d23bf06f25549a12b63c4bc8aab',
    byteLength: 19565,
  },
  firstViewPack: {
    format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1',
    relativePath:
      'objects/sha256/18/182a312fe7651c39826f297c1c6186212305ec9a6c4a67e0d57b03f765e7f401',
    sha256: '182a312fe7651c39826f297c1c6186212305ec9a6c4a67e0d57b03f765e7f401',
    byteLength: 17278,
    bundleManifestSha256: '7830daffeac153a5c62327566c8e8772537a9d23bf06f25549a12b63c4bc8aab',
    bundleFingerprint: '9003f72c766387335b337c952472ed510ccfaa9c396018e4850166362c5dcd54',
    tiers: ['shell', 'view'],
    rosterSha256: '719f49c5dbf0c1aa91bcdb4cedef2e7c7103d7c5db014226dcb05c337667cf1a',
    memberCount: 14,
    uncompressedByteLength: 150025,
  },
  fullTierShards: {
    contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1',
    bundleManifestSha256: '7830daffeac153a5c62327566c8e8772537a9d23bf06f25549a12b63c4bc8aab',
    bundleFingerprint: '9003f72c766387335b337c952472ed510ccfaa9c396018e4850166362c5dcd54',
    tiers: ['detail', 'search'],
    rosterSha256: 'f39417eb6c5bcc88fa2c68a50e97784c3fef2288379fb39f865dbb47311b30ba',
    memberCount: 19,
    individualObjectIds: [],
    shards: [
      {
        format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1',
        relativePath:
          'objects/sha256/95/95c9b2d6fde64017c81c45165b70b307ab1617a77ecadd36d0a6f545ec5834b7',
        sha256: '95c9b2d6fde64017c81c45165b70b307ab1617a77ecadd36d0a6f545ec5834b7',
        byteLength: 33408,
        bundleManifestSha256: '7830daffeac153a5c62327566c8e8772537a9d23bf06f25549a12b63c4bc8aab',
        bundleFingerprint: '9003f72c766387335b337c952472ed510ccfaa9c396018e4850166362c5dcd54',
        shardIndex: 0,
        shardCount: 1,
        rosterSha256: 'f39417eb6c5bcc88fa2c68a50e97784c3fef2288379fb39f865dbb47311b30ba',
        memberCount: 19,
        uncompressedByteLength: 118134,
      },
    ],
  },
} as const) satisfies HostedReferencePreparedBundleAssetV1;
