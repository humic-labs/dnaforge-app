import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { HostedReferenceFirstViewPackAssetV1 } from './hosted-reference-catalog';
import {
  buildPortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  type PortablePreparedReferenceObjectRoleV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';
import {
  buildPortablePreparedReferenceFirstViewPackV1,
  MAX_FIRST_VIEW_PACK_UNCOMPRESSED_BYTES_V1,
  parsePortablePreparedReferenceFirstViewPackV1,
} from './portable-prepared-reference-first-view-pack';

describe('portable prepared-reference first-view pack', () => {
  it('builds deterministic pathless bytes and verifies every ordered CAS member', () => {
    const fixture = fixtureBundle();
    const first = buildPortablePreparedReferenceFirstViewPackV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      memberBytes: fixture.memberBytes,
    });
    const second = buildPortablePreparedReferenceFirstViewPackV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      memberBytes: fixture.memberBytes,
    });

    expect(second.bytes).toEqual(first.bytes);
    const descriptor = descriptorFor(first);
    const parsed = parsePortablePreparedReferenceFirstViewPackV1({
      descriptor,
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      packBytes: first.bytes,
    });
    expect(parsed.map(({ object }) => object.id)).toEqual([
      'definition',
      'view-catalog',
      'raster-manifest',
    ]);
    for (const { object, bytes } of parsed) {
      expect(bytes).toEqual(fixture.memberBytes.get(object.id));
    }
    const expanded = brotliDecompressSync(first.bytes);
    expect(expanded.includes(Buffer.from('shell/definition.bin'))).toBe(false);
    expect(expanded.includes(Buffer.from('view/view-catalog.bin'))).toBe(false);
  });

  it('rejects truncation, over-expansion admission, roster drift, and unknown members', () => {
    const fixture = fixtureBundle();
    const built = buildPortablePreparedReferenceFirstViewPackV1({
      bundleManifestSha256: 'a'.repeat(64),
      bundle: fixture.bundle,
      memberBytes: fixture.memberBytes,
    });
    const descriptor = descriptorFor(built);

    expect(() =>
      parsePortablePreparedReferenceFirstViewPackV1({
        descriptor,
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
        packBytes: built.bytes.subarray(0, built.bytes.byteLength - 1),
      })
    ).toThrow(/byte length/);
    expect(() =>
      parsePortablePreparedReferenceFirstViewPackV1({
        descriptor: {
          ...descriptor,
          uncompressedByteLength: MAX_FIRST_VIEW_PACK_UNCOMPRESSED_BYTES_V1 + 1,
        },
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
        packBytes: built.bytes,
      })
    ).toThrow(/exceeds its bound/);
    expect(() =>
      parsePortablePreparedReferenceFirstViewPackV1({
        descriptor: { ...descriptor, rosterSha256: 'b'.repeat(64) },
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
        packBytes: built.bytes,
      })
    ).toThrow(/roster/);

    const expanded = brotliDecompressSync(built.bytes);
    const headerLength = expanded.readUInt32BE(8);
    const headerStart = 12;
    const header = expanded
      .subarray(headerStart, headerStart + headerLength)
      .toString('utf8')
      .replace('"definition"', '"unknownxxx"');
    expect(Buffer.byteLength(header)).toBe(headerLength);
    Buffer.from(header).copy(expanded, headerStart);
    const alteredBytes = brotliCompressSync(expanded, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: expanded.byteLength,
      },
    });
    expect(() =>
      parsePortablePreparedReferenceFirstViewPackV1({
        descriptor: {
          ...descriptor,
          relativePath: portablePreparedReferenceContentObjectKeyV1(digest(alteredBytes)),
          sha256: digest(alteredBytes),
          byteLength: alteredBytes.byteLength,
        },
        bundleManifestSha256: 'a'.repeat(64),
        bundle: fixture.bundle,
        packBytes: alteredBytes,
      })
    ).toThrow(/unknown|missing|reordered/);
  });
});

function fixtureBundle() {
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
  ];
  const objects = drafts.map((draft) => {
    const bytes = Buffer.from(`${draft.id}-bytes\n`);
    memberBytes.set(draft.id, bytes);
    const sha256 = digest(bytes);
    return {
      ...draft,
      objectKey: portablePreparedReferenceContentObjectKeyV1(sha256),
      sha256,
      byteLength: bytes.byteLength,
    };
  });
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

function descriptorFor(
  built: ReturnType<typeof buildPortablePreparedReferenceFirstViewPackV1>
): HostedReferenceFirstViewPackAssetV1 {
  const sha256 = digest(built.bytes);
  return {
    format: built.format,
    relativePath: portablePreparedReferenceContentObjectKeyV1(sha256),
    sha256,
    byteLength: built.bytes.byteLength,
    bundleManifestSha256: built.bundleManifestSha256,
    bundleFingerprint: built.bundleFingerprint,
    tiers: built.tiers,
    rosterSha256: built.rosterSha256,
    memberCount: built.memberCount,
    uncompressedByteLength: built.uncompressedByteLength,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
