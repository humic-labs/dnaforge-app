import { describe, expect, it } from 'vitest';

import {
  buildPortablePreparedReferenceBundleV1,
  parsePortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  portablePreparedReferenceObjectsForTierV1,
  type PortablePreparedReferenceBundleDraftV1,
  type PortablePreparedReferenceObjectRoleV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function object(
  id: string,
  role: PortablePreparedReferenceObjectRoleV1,
  tier: PortablePreparedReferenceReadinessTierV1,
  dependsOn: readonly string[] = []
) {
  const sha256 = digest(String.fromCharCode(97 + (id.length % 6)));
  return {
    id,
    role,
    objectKey: portablePreparedReferenceContentObjectKeyV1(sha256),
    installPath: `${tier}/${id}.bin`,
    byteLength: id.length + 1,
    sha256,
    contractToken: `${role}.v1`,
    dependsOn,
  } as const;
}

function validDraft(): PortablePreparedReferenceBundleDraftV1 {
  const objects = [
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
  return {
    assembly: {
      id: 'grch38',
      assetCacheKey: 'grch38',
      preparationPipelineRevision: 1,
      assemblyLengthBp: 3_088_269_832,
      contigCount: 24,
      source: {
        fastaSha256: digest('1'),
        gffSha256: digest('2'),
      },
    },
    objects,
    readiness: {
      shell: { dependsOn: [], objectIds: ['definition'] },
      view: {
        dependsOn: ['shell'],
        objectIds: ['view-catalog', 'raster-manifest'],
      },
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
  };
}

describe('portable prepared reference bundle v1', () => {
  it('builds and admits a SHA-addressed manifest without paths, mtimes, or Git identity', () => {
    const bundle = buildPortablePreparedReferenceBundleV1(validDraft());

    expect(bundle.contract).toBe('dnaforge-portable-prepared-reference-bundle.v1');
    expect(bundle.bundleFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      bundle.objects.every(
        (entry) => entry.objectKey === `objects/sha256/${entry.sha256.slice(0, 2)}/${entry.sha256}`
      )
    ).toBe(true);
    expect(JSON.stringify(bundle)).not.toMatch(
      /mtime|ctime|sourceBuildFingerprint|gitSha|\/Users\//
    );
    expect(() =>
      parsePortablePreparedReferenceBundleV1(bundle, {
        assemblyId: 'grch38',
        assetCacheKey: 'grch38',
        preparationPipelineRevision: 1,
        assemblyLengthBp: 3_088_269_832,
        contigCount: 24,
        source: {
          fastaSha256: digest('1'),
          gffSha256: digest('2'),
        },
      })
    ).not.toThrow();
  });

  it('returns exact dependency-ordered closures for progressive readiness', () => {
    const bundle = buildPortablePreparedReferenceBundleV1(validDraft());

    expect(portablePreparedReferenceObjectsForTierV1(bundle, 'shell').map(({ id }) => id)).toEqual([
      'definition',
    ]);
    expect(portablePreparedReferenceObjectsForTierV1(bundle, 'view').map(({ id }) => id)).toEqual([
      'definition',
      'view-catalog',
      'raster-manifest',
    ]);
    expect(portablePreparedReferenceObjectsForTierV1(bundle, 'search').map(({ id }) => id)).toEqual(
      [
        'definition',
        'annotation-search-manifest',
        'annotation-search-payload',
        'protein-search-manifest',
        'protein-search-payload',
      ]
    );
  });

  it('rejects tampering, unknown fields, unsafe paths, and non-content-addressed keys', () => {
    const bundle = buildPortablePreparedReferenceBundleV1(validDraft());

    expect(() =>
      parsePortablePreparedReferenceBundleV1({
        ...bundle,
        unexpectedUrl: 'https://attacker.invalid/bundle',
      })
    ).toThrow('unsupported fields');

    const wrongDigest = structuredClone(bundle);
    (wrongDigest.objects[0] as { byteLength: number }).byteLength += 1;
    expect(() => parsePortablePreparedReferenceBundleV1(wrongDigest)).toThrow(
      'fingerprint does not match'
    );

    const wrongKey = structuredClone(bundle);
    (wrongKey.objects[0] as { objectKey: string }).objectKey =
      'objects/sha256/00/not-the-content-digest';
    expect(() => parsePortablePreparedReferenceBundleV1(wrongKey)).toThrow('.objectKey must be');

    const escaping = structuredClone(bundle);
    (escaping.objects[0] as { installPath: string }).installPath = '../outside';
    expect(() => parsePortablePreparedReferenceBundleV1(escaping)).toThrow(
      'safe generation-relative path'
    );

    const windowsDrive = structuredClone(bundle);
    (windowsDrive.objects[0] as { installPath: string }).installPath = 'C:/outside';
    expect(() => parsePortablePreparedReferenceBundleV1(windowsDrive)).toThrow(
      'safe generation-relative path'
    );
  });

  it('rejects incomplete, cyclic, duplicated, and forward-dependent readiness graphs', () => {
    const missingRole = validDraft();
    const requiredRasterManifest = missingRole.objects.find(({ id }) => id === 'raster-manifest')!;
    (
      requiredRasterManifest as {
        role: PortablePreparedReferenceObjectRoleV1;
      }
    ).role = 'prepared-source-receipt';
    expect(() => buildPortablePreparedReferenceBundleV1(missingRole)).toThrow(
      'view readiness is missing roles: broad-raster-manifest'
    );

    const cyclic = validDraft();
    const definition = cyclic.objects.find(({ id }) => id === 'definition')!;
    (definition as { dependsOn: readonly string[] }).dependsOn = ['view-catalog'];
    expect(() => buildPortablePreparedReferenceBundleV1(cyclic)).toThrow('dependency cycle');

    const original = validDraft();
    const duplicated: PortablePreparedReferenceBundleDraftV1 = {
      ...original,
      readiness: {
        ...original.readiness,
        search: {
          ...original.readiness.search,
          objectIds: [...original.readiness.search.objectIds, 'definition'],
        },
      },
    };
    expect(() => buildPortablePreparedReferenceBundleV1(duplicated)).toThrow(
      'assigned to both shell and search'
    );

    const forward = validDraft();
    const annotationSearch = forward.objects.find(({ id }) => id === 'annotation-search-manifest')!;
    (annotationSearch as { dependsOn: readonly string[] }).dependsOn = ['fasta'];
    expect(() => buildPortablePreparedReferenceBundleV1(forward)).toThrow(
      'search object "annotation-search-manifest" cannot depend on detail object "fasta"'
    );
  });

  it('binds admission to the exact catalog assembly and raw-source digests', () => {
    const bundle = buildPortablePreparedReferenceBundleV1(validDraft());

    expect(() =>
      parsePortablePreparedReferenceBundleV1(bundle, { assemblyId: 'not-grch38' })
    ).toThrow('assembly ID does not match');
    expect(() =>
      parsePortablePreparedReferenceBundleV1(bundle, {
        source: { fastaSha256: digest('3'), gffSha256: digest('2') },
      })
    ).toThrow('source identity does not match');
    expect(() =>
      parsePortablePreparedReferenceBundleV1(bundle, { preparationPipelineRevision: 2 })
    ).toThrow('pipeline revision is incompatible');
  });

  it('admits fasta-gzi as an optional detail object without requiring it', () => {
    const draft = validDraft();
    const withGzi: PortablePreparedReferenceBundleDraftV1 = {
      ...draft,
      objects: [...draft.objects, object('chr1-fasta-gzi', 'fasta-gzi', 'detail', ['fasta'])],
      readiness: {
        ...draft.readiness,
        detail: {
          ...draft.readiness.detail,
          objectIds: [...draft.readiness.detail.objectIds, 'chr1-fasta-gzi'],
        },
      },
    };

    expect(
      buildPortablePreparedReferenceBundleV1(withGzi).objects.some(
        ({ role }) => role === 'fasta-gzi'
      )
    ).toBe(true);
    expect(
      buildPortablePreparedReferenceBundleV1(validDraft()).objects.some(
        ({ role }) => role === 'fasta-gzi'
      )
    ).toBe(false);
  });

  it('authenticates a raster child catalog without enumerating its lazy cells', () => {
    const bundle = buildPortablePreparedReferenceBundleV1(validDraft());
    const rasterManifest = bundle.objects.find(({ role }) => role === 'broad-raster-manifest');

    expect(rasterManifest).toMatchObject({
      id: 'raster-manifest',
      role: 'broad-raster-manifest',
    });
    expect(bundle.objects.some(({ role }) => role === ('broad-raster-cell' as string))).toBe(false);
    expect(portablePreparedReferenceObjectsForTierV1(bundle, 'view')).toEqual(
      expect.arrayContaining([rasterManifest])
    );

    const legacyCell = structuredClone(bundle);
    const manifest = legacyCell.objects.find(({ role }) => role === 'broad-raster-manifest')!;
    (
      manifest as {
        role: string;
      }
    ).role = 'broad-raster-cell';
    expect(() => parsePortablePreparedReferenceBundleV1(legacyCell)).toThrow(
      '.role is unsupported'
    );
  });
});
