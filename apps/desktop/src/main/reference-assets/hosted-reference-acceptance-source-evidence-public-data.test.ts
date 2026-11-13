import { describe, expect, it } from 'vitest';

import { HOSTED_REFERENCE_BUILD_CATALOG_V1 } from './hosted-reference-build-catalog';
import { PUBLIC_HOSTED_REFERENCE_SOURCE_ACCEPTANCE_V1 } from './hosted-reference-acceptance-source-evidence-public-data';

const PUBLIC_MISSING_COHORT_IDS = [
  'hg19',
  'mm10',
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
] as const;

describe(' source-derived acceptance evidence', () => {
  it('locks every missing source exactly once against the build catalog', () => {
    expect(Object.keys(PUBLIC_HOSTED_REFERENCE_SOURCE_ACCEPTANCE_V1)).toEqual(
      PUBLIC_MISSING_COHORT_IDS
    );
    expect(Object.isFrozen(PUBLIC_HOSTED_REFERENCE_SOURCE_ACCEPTANCE_V1)).toBe(true);
    const buildCatalog = new Map(
      HOSTED_REFERENCE_BUILD_CATALOG_V1.map((entry) => [entry.id, entry])
    );
    for (const id of PUBLIC_MISSING_COHORT_IDS) {
      const evidence = PUBLIC_HOSTED_REFERENCE_SOURCE_ACCEPTANCE_V1[id];
      const source = buildCatalog.get(id);
      expect(source, id).toBeDefined();
      expect(evidence.rawGff3Sha256, id).toBe(source?.sources.annotations.sha256);
      expect(Object.isFrozen(evidence), id).toBe(true);
      expect(Object.isFrozen(evidence.expectedAnnotationTrackTypes), id).toBe(true);
      expect(Object.isFrozen(evidence.witness), id).toBe(true);
      expect(evidence.expectedAnnotationTrackTypes, id).toEqual(
        [...new Set(evidence.expectedAnnotationTrackTypes)].sort((left, right) =>
          left.localeCompare(right)
        )
      );
      expect(evidence.expectedAnnotationTrackTypes, id).toContain(evidence.witness.trackType);
      expect(evidence.witness.featureType, id).not.toBe('');
      expect(evidence.witness.localStartBp, id).toBeGreaterThanOrEqual(0);
      expect(evidence.witness.localEndBp, id).toBeLessThanOrEqual(evidence.primaryContigLengthBp);
      expect(evidence.witness.localCenterBp, id).toBeGreaterThanOrEqual(
        evidence.witness.localStartBp
      );
      expect(evidence.witness.localCenterBp, id).toBeLessThanOrEqual(evidence.witness.localEndBp);
      if (evidence.witness.transcriptId === null) {
        expect(evidence.witness.exonCount, id).toBe(0);
        expect(evidence.witness.cdsCount, id).toBe(0);
      } else {
        expect(evidence.witness.exonCount, id).toBeGreaterThan(0);
        expect(evidence.witness.cdsCount, id).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
