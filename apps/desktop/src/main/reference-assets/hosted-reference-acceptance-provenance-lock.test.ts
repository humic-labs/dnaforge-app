import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL,
  HOSTED_REFERENCE_CATALOG_V1,
} from './hosted-reference-catalog';
import {
  assertHostedReferenceAcceptanceProvenance,
  HOSTED_REFERENCE_ACCEPTANCE_PROVENANCE_LOCK_V1,
  hostedReferenceAcceptanceFirstViewTransportFailures,
  hostedReferenceAcceptanceFirstViewTransportMilestone,
  hostedReferenceAcceptanceProvenanceFailures,
  type HostedReferenceAcceptanceCandidateV1,
  type HostedReferenceAcceptanceCatalogEntryV1,
} from './hosted-reference-acceptance-provenance-lock';

type MutableCatalogEntry = {
  id: string;
  provenance: {
    datasetId: string;
  };
  sources: {
    fasta: {
      relativePath: string;
      sha256: string;
    };
    annotations: {
      relativePath: string;
      sha256: string;
    };
  };
  preparedBundle?: {
    manifest: {
      relativePath: string;
      sha256: string;
    };
    firstViewPack?: {
      relativePath: string;
      sha256: string;
      bundleManifestSha256: string;
      bundleFingerprint: string;
      rosterSha256: string;
    };
  };
};

function productionCandidate(): HostedReferenceAcceptanceCandidateV1 {
  return {
    assetBaseUrl: DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL,
    catalog: HOSTED_REFERENCE_CATALOG_V1,
  };
}

function mutableCatalog(): MutableCatalogEntry[] {
  return Array.from(structuredClone(HOSTED_REFERENCE_CATALOG_V1));
}

function failuresFor(catalog: ReadonlyArray<HostedReferenceAcceptanceCatalogEntryV1>): string {
  return hostedReferenceAcceptanceProvenanceFailures({
    assetBaseUrl: DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL,
    catalog,
  }).join('\n');
}

function requiredPreparedAssets(entry: MutableCatalogEntry): {
  manifest: NonNullable<MutableCatalogEntry['preparedBundle']>['manifest'];
  pack: NonNullable<NonNullable<MutableCatalogEntry['preparedBundle']>['firstViewPack']>;
} {
  const manifest = entry.preparedBundle?.manifest;
  const pack = entry.preparedBundle?.firstViewPack;
  if (!manifest || !pack) throw new Error(`production catalog entry ${entry.id} is not prepared`);
  return { manifest, pack };
}

describe('hosted-reference acceptance provenance lock', () => {
  it('independently admits the exact current production catalog', () => {
    expect(hostedReferenceAcceptanceProvenanceFailures(productionCandidate())).toEqual([]);
    expect(() => assertHostedReferenceAcceptanceProvenance(productionCandidate())).not.toThrow();
  });

  it('is immutable at runtime and contains only the sixty-five admitted production IDs', () => {
    const lock = HOSTED_REFERENCE_ACCEPTANCE_PROVENANCE_LOCK_V1;
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock.references)).toBe(true);
    expect(Object.keys(lock.references)).toEqual([
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
      'kphaffiiGs115',
      'kphaffiiCbs7435',
      'candidaSC5314',
      'anidulansFgscA4',
      'pfalciparum3d7',
      'agambiaeF1',
      'medakaHdRr31',
      'galGal6',
      'canFam6',
      'susScr11',
      'bosTau9',
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
    for (const identity of Object.values(lock.references)) {
      expect(Object.isFrozen(identity)).toBe(true);
      expect(Object.isFrozen(identity.firstViewTransport)).toBe(true);
      if (identity.expectedAnnotationTrackTypes !== null) {
        expect(Object.isFrozen(identity.expectedAnnotationTrackTypes)).toBe(true);
        expect(identity.expectedAnnotationTrackTypes).toEqual(
          [...identity.expectedAnnotationTrackTypes].sort()
        );
        expect(new Set(identity.expectedAnnotationTrackTypes).size).toBe(
          identity.expectedAnnotationTrackTypes.length
        );
      }
      const transport = identity.firstViewTransport;
      const sha256Values: string[] = [
        identity.rawFastaSha256,
        identity.rawGff3Sha256,
        identity.preparedManifestSha256,
        identity.preparedBundleFingerprint,
        identity.firstViewRosterSha256,
      ];
      if (transport.kind === 'pack') sha256Values.push(transport.sha256);
      for (const sha256 of sha256Values) {
        expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(lock.references.grch38.expectedAnnotationTrackTypes).toBeNull();
    expect(lock.references.sacCer3.expectedAnnotationTrackTypes).toHaveLength(70);
    expect(lock.references.ce11.expectedAnnotationTrackTypes).toHaveLength(18);
    expect(lock.references.tair10.expectedAnnotationTrackTypes).toEqual([
      'antisense_RNA',
      'genomic DNA',
      'lnc_RNA',
      'mRNA',
      'miRNA',
      'ncRNA',
      'primary_transcript',
      'pseudogene',
      'rRNA',
      'sequence_feature',
      'snRNA',
      'snoRNA',
      'tRNA',
      'transcript',
    ]);
    expect(lock.references.mm39.expectedAnnotationTrackTypes).toHaveLength(51);
    expect(lock.references.mm39.firstViewTransport).toEqual({ kind: 'individual-objects' });
    expect(lock.references.mm39.firstViewRosterSha256).toBe(
      'f5f444e2f51f4a4d7d7f486f102c61374d056aae347c817fc6ddbed0abca6750'
    );
    expect(lock.references.wheatRefseqV21.expectedAnnotationTrackTypes).toHaveLength(11);
    expect(lock.references.wheatRefseqV21.firstViewTransport).toEqual({
      kind: 'individual-objects',
    });
    expect(lock.references.wheatRefseqV21.firstViewRosterSha256).toBe(
      '8247845b3acc224a093c2beb54d119c613ccd3cbc618432f3ed215c54d8dc459'
    );
    expect(lock.references.grcz12tu.expectedAnnotationTrackTypes).toHaveLength(18);
    expect(lock.references.grcz12tu.firstViewTransport).toMatchObject({
      kind: 'pack',
      sha256: 'bcdfda150189852b3754232d7ba4deb4e01e3181dae11e372dbe2b1eb24ed0a6',
    });
    expect(lock.references.dm6.expectedAnnotationTrackTypes).toHaveLength(144);
    expect(lock.references.dm6.firstViewTransport).toMatchObject({
      kind: 'pack',
      sha256: '8abdbd3ab929b2b5439ab13ca3fc4a7f650b96cd2defcf6da3398a7cad66854a',
    });
    expect(lock.references.t2tMmu8v2.expectedAnnotationTrackTypes).toHaveLength(17);
    expect(lock.references.rheMac10.expectedAnnotationTrackTypes).toHaveLength(19);
    expect(lock.references.mPanTro3v21.expectedAnnotationTrackTypes).toHaveLength(17);
    expect(lock.references.mGorGor1v21.expectedAnnotationTrackTypes).toHaveLength(18);
    expect(lock.references.mOryCun11.expectedAnnotationTrackTypes).toHaveLength(17);
    expect(lock.references.oarRambouilletV3.expectedAnnotationTrackTypes).toHaveLength(17);
    expect(lock.references.equCabTbT2t.expectedAnnotationTrackTypes).toHaveLength(17);
    expect(lock.references.equCabTbT2t.firstViewTransport).toMatchObject({
      kind: 'pack',
      sha256: '9f3db722a3dd9a672ef71e54bd72e1f357b3f0a76a9593b6731dba02900be9c7',
    });
    const wave05Expectations = {
      hs1: { trackCount: 145, firstView: 'individual-objects' },
      rn8: { trackCount: 20, firstView: 'pack' },
      rn7: { trackCount: 22, firstView: 'pack' },
      danRer11: { trackCount: 20, firstView: 'pack' },
      pombeAsm294v3: { trackCount: 13, firstView: 'pack' },
      xenLae10: { trackCount: 19, firstView: 'pack' },
      grcg7b: { trackCount: 19, firstView: 'pack' },
      canFam4: { trackCount: 18, firstView: 'pack' },
    } as const;
    const publicWave01Expectations = {
      hg19: { trackCount: 4, firstView: 'individual-objects' },
      mm10: { trackCount: 4, firstView: 'individual-objects' },
      susScrHxylV2: { trackCount: 19, firstView: 'pack' },
      arsUcd2: { trackCount: 22, firstView: 'pack' },
      criGriPicrh1: { trackCount: 16, firstView: 'pack' },
      panTro6: { trackCount: 4, firstView: 'individual-objects' },
      medakaHdRr31: { trackCount: 15, firstView: 'pack' },
      grcz12ab: { trackCount: 20, firstView: 'pack' },
    } as const;
    const publicWave02Expectations = {
      galGal6: { trackCount: 18, firstView: 'pack' },
      canFam6: { trackCount: 18, firstView: 'pack' },
      canFam3: { trackCount: 13, firstView: 'pack' },
      susScr11: { trackCount: 13, firstView: 'pack' },
      bosTau9: { trackCount: 20, firstView: 'pack' },
      pomBase: { trackCount: 14, firstView: 'pack' },
      tomatoSlmR21: { trackCount: 14, firstView: 'pack' },
    } as const;
    const publicWave03Expectations = {
      irgsp1: { trackCount: 14, firstView: 'pack' },
      soybeanV4: { trackCount: 14, firstView: 'pack' },
      ntK326: { trackCount: 16, firstView: 'pack' },
      kphaffiiGs115: { trackCount: 2, firstView: 'pack' },
      kphaffiiCbs7435: { trackCount: 5, firstView: 'pack' },
      candidaSC5314: { trackCount: 13, firstView: 'pack' },
      anidulansFgscA4: { trackCount: 5, firstView: 'pack' },
      pfalciparum3d7: { trackCount: 9, firstView: 'pack' },
      agambiaeF1: { trackCount: 10, firstView: 'pack' },
    } as const;
    const publicExtraDemandExpectations = {
      t2tMfa8v11: { trackCount: 14, firstView: 'pack' },
      sbicolorNcbiv3: { trackCount: 8, firstView: 'pack' },
      sarsCov2WuhanHu1: { trackCount: 4, firstView: 'pack' },
      nibenKlab: { trackCount: 2, firstView: 'pack' },
    } as const;
    const publicBacteriaExpectations = {
      ecoliK12Mg1655: { trackCount: 58, firstView: 'pack' },
      ecoliBl21De3: { trackCount: 13, firstView: 'pack' },
      bacillus168: { trackCount: 9, firstView: 'pack' },
      pputidaKt2440: { trackCount: 11, firstView: 'pack' },
      cglutamicumAtcc13032: { trackCount: 9, firstView: 'pack' },
      scoelicolorA32: { trackCount: 9, firstView: 'pack' },
      mtbH37Rv: { trackCount: 65, firstView: 'pack' },
      paeruginosaPao1: { trackCount: 9, firstView: 'pack' },
      saureusNctc8325: { trackCount: 6, firstView: 'pack' },
      salmonellaLt2: { trackCount: 19, firstView: 'pack' },
      saureusUsa300Fpr3757: { trackCount: 7, firstView: 'pack' },
    } as const;
    for (const [id, expected] of Object.entries(wave05Expectations)) {
      const identity = lock.references[id as keyof typeof wave05Expectations];
      expect(identity.expectedAnnotationTrackTypes).toHaveLength(expected.trackCount);
      expect(identity.firstViewTransport.kind).toBe(expected.firstView);
    }
    for (const [id, expected] of Object.entries(publicWave01Expectations)) {
      const identity = lock.references[id as keyof typeof publicWave01Expectations];
      expect(identity.expectedAnnotationTrackTypes).toHaveLength(expected.trackCount);
      expect(identity.firstViewTransport.kind).toBe(expected.firstView);
    }
    for (const [id, expected] of Object.entries(publicWave02Expectations)) {
      const identity = lock.references[id as keyof typeof publicWave02Expectations];
      expect(identity.expectedAnnotationTrackTypes).toHaveLength(expected.trackCount);
      expect(identity.firstViewTransport.kind).toBe(expected.firstView);
    }
    for (const [id, expected] of Object.entries(publicWave03Expectations)) {
      const identity = lock.references[id as keyof typeof publicWave03Expectations];
      expect(identity.expectedAnnotationTrackTypes).toHaveLength(expected.trackCount);
      expect(identity.firstViewTransport.kind).toBe(expected.firstView);
    }
    for (const [id, expected] of Object.entries(publicExtraDemandExpectations)) {
      const identity = lock.references[id as keyof typeof publicExtraDemandExpectations];
      expect(identity.expectedAnnotationTrackTypes).toHaveLength(expected.trackCount);
      expect(identity.firstViewTransport.kind).toBe(expected.firstView);
    }
    for (const [id, expected] of Object.entries(publicBacteriaExpectations)) {
      const identity = lock.references[id as keyof typeof publicBacteriaExpectations];
      expect(identity.expectedAnnotationTrackTypes).toHaveLength(expected.trackCount);
      expect(identity.firstViewTransport.kind).toBe(expected.firstView);
    }
    expect(lock.references.hs1.firstViewRosterSha256).toBe(
      '89ab20e3ab87cefad3a9ab6d4f7540b84327e30975a45e5a8ab57ca4c5fc0b06'
    );
    expect(lock.references.grch38.firstViewTransport).toEqual({ kind: 'individual-objects' });
    expect(lock.references.grch38.firstViewRosterSha256).toBe(
      'd18a8fd874e193563d14afdee54154dd431a175d4b7e378babd55fbed46d652e'
    );
  });

  it('fails closed when a pack identity has no pack', () => {
    const expected = HOSTED_REFERENCE_ACCEPTANCE_PROVENANCE_LOCK_V1.references.ce11;
    expect(
      hostedReferenceAcceptanceFirstViewTransportFailures('fixture', expected, undefined)
    ).toEqual(
      expect.arrayContaining(['fixture.firstViewTransport expected=pack actual=individual-objects'])
    );
  });

  it('fails closed when an individual-object identity has an unexpected pack', () => {
    const catalog = mutableCatalog();
    const ce11 = catalog.find(({ id }) => id === 'ce11');
    if (!ce11) throw new Error('production ce11 catalog entry is missing');
    const { pack } = requiredPreparedAssets(ce11);
    const expected = {
      ...HOSTED_REFERENCE_ACCEPTANCE_PROVENANCE_LOCK_V1.references.ce11,
      firstViewTransport: { kind: 'individual-objects' as const },
    };

    expect(hostedReferenceAcceptanceFirstViewTransportFailures('fixture', expected, pack)).toEqual([
      'fixture.firstViewTransport expected=individual-objects actual=pack',
    ]);
  });

  it('emits a distinct acceptance milestone for each first-view transport', () => {
    expect(
      hostedReferenceAcceptanceFirstViewTransportMilestone({ kind: 'individual-objects' })
    ).toBe('canonical-individual-objects');
    expect(
      hostedReferenceAcceptanceFirstViewTransportMilestone({
        kind: 'pack',
        relativePath: 'objects/sha256/00/example',
        sha256: '0'.repeat(64),
      })
    ).toBe('canonical-first-view-pack');
  });

  it('rejects a noncanonical hosted origin', () => {
    expect(
      hostedReferenceAcceptanceProvenanceFailures({
        ...productionCandidate(),
        assetBaseUrl: 'https://example.invalid/reference-genomes/v1/',
      }).join('\n')
    ).toMatch(
      /assetBaseUrl expected=https:\/\/references\.dnaforge\.com\/.*actual=https:\/\/example\.invalid/
    );
  });

  it('fails closed on a missing, unexpected, or duplicate production ID', () => {
    const missing = mutableCatalog().filter(({ id }) => id !== 'ce11');
    expect(failuresFor(missing)).toMatch(/production hosted IDs missing: ce11/);

    const unexpected = mutableCatalog();
    unexpected.push({ ...structuredClone(unexpected[0]), id: 'unexpected-reference' });
    expect(failuresFor(unexpected)).toMatch(
      /production hosted IDs unexpected: unexpected-reference/
    );

    const duplicate = mutableCatalog();
    duplicate.push(structuredClone(duplicate[0]));
    expect(failuresFor(duplicate)).toMatch(/production hosted ID duplicated: grch38/);
  });

  const mutations: ReadonlyArray<{
    label: string;
    expectedFailure: RegExp;
    mutate: (entry: MutableCatalogEntry) => void;
  }> = [
    {
      label: 'assembly accession',
      expectedFailure: /ce11\.assemblyAccession/,
      mutate: (entry) => {
        entry.provenance.datasetId = 'GCF_000001405.39';
      },
    },
    {
      label: 'raw FASTA path',
      expectedFailure: /ce11\.rawFastaRelativePath/,
      mutate: (entry) => {
        entry.sources.fasta.relativePath = 'wrong/fasta';
      },
    },
    {
      label: 'raw FASTA SHA-256',
      expectedFailure: /ce11\.rawFastaSha256/,
      mutate: (entry) => {
        entry.sources.fasta.sha256 = '0'.repeat(64);
      },
    },
    {
      label: 'raw GFF3 path',
      expectedFailure: /ce11\.rawGff3RelativePath/,
      mutate: (entry) => {
        entry.sources.annotations.relativePath = 'wrong/gff3';
      },
    },
    {
      label: 'raw GFF3 SHA-256',
      expectedFailure: /ce11\.rawGff3Sha256/,
      mutate: (entry) => {
        entry.sources.annotations.sha256 = '0'.repeat(64);
      },
    },
    {
      label: 'prepared manifest path',
      expectedFailure: /ce11\.preparedManifestRelativePath/,
      mutate: (entry) => {
        requiredPreparedAssets(entry).manifest.relativePath = 'wrong/manifest';
      },
    },
    {
      label: 'prepared manifest SHA-256',
      expectedFailure: /ce11\.preparedManifestSha256/,
      mutate: (entry) => {
        requiredPreparedAssets(entry).manifest.sha256 = '0'.repeat(64);
      },
    },
    {
      label: 'first-view pack path',
      expectedFailure: /ce11\.firstViewTransport\.relativePath/,
      mutate: (entry) => {
        requiredPreparedAssets(entry).pack.relativePath = 'wrong/pack';
      },
    },
    {
      label: 'first-view pack SHA-256',
      expectedFailure: /ce11\.firstViewTransport\.sha256/,
      mutate: (entry) => {
        requiredPreparedAssets(entry).pack.sha256 = '0'.repeat(64);
      },
    },
    {
      label: 'first-view pack manifest binding',
      expectedFailure: /ce11\.firstViewPack\.bundleManifestSha256/,
      mutate: (entry) => {
        requiredPreparedAssets(entry).pack.bundleManifestSha256 = '0'.repeat(64);
      },
    },
    {
      label: 'prepared bundle fingerprint',
      expectedFailure: /ce11\.preparedBundleFingerprint/,
      mutate: (entry) => {
        requiredPreparedAssets(entry).pack.bundleFingerprint = '0'.repeat(64);
      },
    },
    {
      label: 'first-view roster SHA-256',
      expectedFailure: /ce11\.firstViewRosterSha256/,
      mutate: (entry) => {
        requiredPreparedAssets(entry).pack.rosterSha256 = '0'.repeat(64);
      },
    },
  ];

  for (const mutation of mutations) {
    it(`rejects a mutable-catalog ${mutation.label} substitution`, () => {
      const catalog = mutableCatalog();
      const ce11 = catalog.find(({ id }) => id === 'ce11');
      if (!ce11) throw new Error('production ce11 catalog entry is missing');
      mutation.mutate(ce11);
      expect(failuresFor(catalog)).toMatch(mutation.expectedFailure);
    });
  }

  it('rejects removal of the prepared manifest or first-view pack', () => {
    const missingBundle = mutableCatalog();
    const missingBundleCe11 = missingBundle.find(({ id }) => id === 'ce11');
    if (!missingBundleCe11) throw new Error('production ce11 catalog entry is missing');
    delete missingBundleCe11.preparedBundle;
    expect(failuresFor(missingBundle)).toMatch(/ce11\.preparedManifestRelativePath.*<missing>/);
    expect(failuresFor(missingBundle)).toMatch(
      /ce11\.firstViewTransport expected=pack actual=individual-objects/
    );

    const missingPack = mutableCatalog();
    const missingPackSacCer3 = missingPack.find(({ id }) => id === 'sacCer3');
    if (!missingPackSacCer3?.preparedBundle) {
      throw new Error('production sacCer3 prepared bundle is missing');
    }
    delete missingPackSacCer3.preparedBundle.firstViewPack;
    expect(failuresFor(missingPack)).toMatch(
      /sacCer3\.firstViewTransport expected=pack actual=individual-objects/
    );
  });

  it('throws with every rejection reason instead of admitting a partial match', () => {
    const catalog = mutableCatalog().filter(({ id }) => id !== 'sacCer3');
    expect(() =>
      assertHostedReferenceAcceptanceProvenance({
        assetBaseUrl: 'https://example.invalid/',
        catalog,
      })
    ).toThrow(/assetBaseUrl[\s\S]*production hosted IDs missing: sacCer3/);
  });
});
