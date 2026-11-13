import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildPortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  type PortablePreparedReferenceObjectRoleV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';
import {
  admitPortablePreparedReferenceFullTierShardsDescriptorV1,
  buildPortablePreparedReferenceFullTierShardV1,
  buildPortablePreparedReferenceFullTierShardsDescriptorV1,
  MAX_FULL_TIER_SHARD_COMPRESSED_BYTES_V1,
  MAX_FULL_TIER_SHARD_MEMBER_PAYLOAD_BYTES_V1,
  MAX_FULL_TIER_SHARD_MEMBERS_V1,
  MAX_FULL_TIER_SHARD_UNCOMPRESSED_BYTES_V1,
  parsePortablePreparedReferenceFullTierShardV1,
  portablePreparedReferenceFullTierShardPlanV1,
} from './portable-prepared-reference-full-tier-shards';

describe('portable prepared-reference full-tier shards', () => {
  it('builds deterministic bounded shards and verifies every ordered member', () => {
    const fixture = fixtureBundle();
    const first = buildPortablePreparedReferenceFullTierShardV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      shardIndex: 0,
      memberBytes: fixture.memberBytes,
    });
    const second = buildPortablePreparedReferenceFullTierShardV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      shardIndex: 0,
      memberBytes: fixture.memberBytes,
    });
    expect(second).toEqual(first);
    expect(first.bytes.byteLength).toBeLessThanOrEqual(MAX_FULL_TIER_SHARD_COMPRESSED_BYTES_V1);
    expect(first.descriptor.uncompressedByteLength).toBeLessThanOrEqual(
      MAX_FULL_TIER_SHARD_UNCOMPRESSED_BYTES_V1
    );

    const collection = buildPortablePreparedReferenceFullTierShardsDescriptorV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      shards: [first.descriptor],
    });
    const parsed = parsePortablePreparedReferenceFullTierShardV1({
      collection,
      descriptor: collection.shards[0]!,
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      shardBytes: first.bytes,
    });
    expect(parsed.map(({ object }) => object.id)).toEqual([
      'fasta',
      'fai',
      'gff',
      'tbi',
      'scene-manifest',
      'scene-payload',
      'annotation-search-manifest',
      'annotation-search-payload',
      'protein-search-manifest',
      'protein-search-payload',
    ]);
    for (const { object, bytes } of parsed) {
      expect(bytes).toEqual(fixture.memberBytes.get(object.id));
    }
  });

  it('partitions by hard byte/member bounds and leaves oversized members on exact fallback', () => {
    const fixture = fixtureBundle({
      fastaByteLength: MAX_FULL_TIER_SHARD_MEMBER_PAYLOAD_BYTES_V1 + 1,
      extraSearchPayloads: MAX_FULL_TIER_SHARD_MEMBERS_V1,
    });
    const plan = portablePreparedReferenceFullTierShardPlanV1(fixture.bundle);

    expect(plan.individualObjects.map(({ id }) => id)).toEqual(['fasta']);
    expect(plan.shards.length).toBeGreaterThan(1);
    const transportedIds = new Set(
      plan.shards.flatMap(({ objects }) => objects.map(({ id }) => id))
    );
    expect(transportedIds.has('fasta')).toBe(false);
    expect(transportedIds.size + plan.individualObjects.length).toBe(plan.roster.length);
    for (const shard of plan.shards) {
      expect(shard.objects).toHaveLength(
        Math.min(shard.objects.length, MAX_FULL_TIER_SHARD_MEMBERS_V1)
      );
      expect(
        shard.objects.reduce((total, object) => total + object.byteLength + 8, 0)
      ).toBeLessThanOrEqual(MAX_FULL_TIER_SHARD_MEMBER_PAYLOAD_BYTES_V1);
    }
  });

  it('rejects collection drift, shard truncation, and descriptor over-expansion', () => {
    const fixture = fixtureBundle();
    const built = buildPortablePreparedReferenceFullTierShardV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      shardIndex: 0,
      memberBytes: fixture.memberBytes,
    });
    const collection = buildPortablePreparedReferenceFullTierShardsDescriptorV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      shards: [built.descriptor],
    });

    expect(() =>
      admitPortablePreparedReferenceFullTierShardsDescriptorV1({
        descriptor: { ...collection, individualObjectIds: ['fasta'] },
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
      })
    ).toThrow(/fallback roster/);
    expect(() =>
      admitPortablePreparedReferenceFullTierShardsDescriptorV1({
        descriptor: {
          ...collection,
          shards: [{ ...collection.shards[0]!, rosterSha256: 'b'.repeat(64) }],
        },
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
      })
    ).toThrow(/deterministic member roster/);
    expect(() =>
      parsePortablePreparedReferenceFullTierShardV1({
        collection,
        descriptor: collection.shards[0]!,
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
        shardBytes: built.bytes.subarray(0, built.bytes.byteLength - 1),
      })
    ).toThrow(/byte length/);
    expect(() =>
      admitPortablePreparedReferenceFullTierShardsDescriptorV1({
        descriptor: {
          ...collection,
          shards: [
            {
              ...collection.shards[0]!,
              uncompressedByteLength: MAX_FULL_TIER_SHARD_UNCOMPRESSED_BYTES_V1 + 1,
            },
          ],
        },
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
      })
    ).toThrow(/exceeds its bound/);
  });
});

function fixtureBundle(options?: {
  readonly fastaByteLength?: number;
  readonly extraSearchPayloads?: number;
}) {
  const memberBytes = new Map<string, Buffer>();
  const drafts = [
    object('definition', 'prepared-reference-definition', 'shell'),
    object('view-catalog', 'view-catalog', 'view', ['definition']),
    object('raster-manifest', 'broad-raster-manifest', 'view', ['view-catalog']),
    object('fasta', 'fasta', 'detail', ['definition']),
    object('fai', 'fasta-index', 'detail', ['fasta']),
    object('gff', 'gff3-bgzf', 'detail', ['definition']),
    object('tbi', 'gff3-tabix', 'detail', ['gff']),
    object('scene-manifest', 'annotation-scene-manifest', 'detail', ['raster-manifest']),
    object('scene-payload', 'annotation-scene-payload', 'detail', ['scene-manifest']),
    object('annotation-search-manifest', 'annotation-search-manifest', 'search', ['definition']),
    object('annotation-search-payload', 'annotation-search-payload', 'search', [
      'annotation-search-manifest',
    ]),
    object('protein-search-manifest', 'protein-search-manifest', 'search', ['definition']),
    object('protein-search-payload', 'protein-search-payload', 'search', [
      'protein-search-manifest',
    ]),
    ...Array.from({ length: options?.extraSearchPayloads ?? 0 }, (_, index) =>
      object(`extra-search-${index}`, 'protein-search-payload', 'search', [
        'protein-search-manifest',
      ])
    ),
  ];
  const objects = drafts.map((draft) => {
    const bytes = Buffer.from(`${draft.id}-bytes\n`);
    memberBytes.set(draft.id, bytes);
    const sha256 = digest(bytes);
    return {
      ...draft,
      objectKey: portablePreparedReferenceContentObjectKeyV1(sha256),
      sha256,
      byteLength:
        draft.id === 'fasta' && options?.fastaByteLength
          ? options.fastaByteLength
          : bytes.byteLength,
    };
  });
  const extraIds = drafts.filter(({ id }) => id.startsWith('extra-search-')).map(({ id }) => id);
  const bundle = buildPortablePreparedReferenceBundleV1({
    assembly: {
      id: 'fixture',
      assetCacheKey: 'fixture',
      preparationPipelineRevision: 1,
      assemblyLengthBp: 100,
      contigCount: 1,
      source: { fastaSha256: '1'.repeat(64), gffSha256: '2'.repeat(64) },
    },
    objects,
    readiness: {
      shell: { dependsOn: [], objectIds: ['definition'] },
      view: { dependsOn: ['shell'], objectIds: ['view-catalog', 'raster-manifest'] },
      detail: {
        dependsOn: ['view'],
        objectIds: ['fasta', 'fai', 'gff', 'tbi', 'scene-manifest', 'scene-payload'],
      },
      search: {
        dependsOn: ['shell'],
        objectIds: [
          'annotation-search-manifest',
          'annotation-search-payload',
          'protein-search-manifest',
          'protein-search-payload',
          ...extraIds,
        ],
      },
    },
  });
  return { bundle, memberBytes };
}

function object(
  id: string,
  role: PortablePreparedReferenceObjectRoleV1,
  tier: PortablePreparedReferenceReadinessTierV1,
  dependsOn: readonly string[] = []
) {
  return {
    id,
    role,
    installPath: `${tier}/${id}.bin`,
    contractToken: `${role}.v1`,
    dependsOn,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
