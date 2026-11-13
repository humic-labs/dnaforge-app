// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  findGoldenGateOverhangSetConflicts,
  getGoldenGateFidelityDataset,
  getGoldenGateFidelityDatasetForEnzyme,
  getGoldenGateFidelitySource,
  reverseComplementOverhang,
  scoreGoldenGateOverhangSet,
  type GoldenGateFidelityDatasetKey,
} from './GoldenGateFidelityDataset';

describe('GoldenGateFidelityDataset', () => {
  it('keeps the bundled four-base Pryor/Potapov PLOS tables tied to their source files', () => {
    const source = getGoldenGateFidelitySource();

    expect(source.doi).toBe('10.1371/journal.pone.0238592');
    expect(source.license).toBe('CC BY 4.0');

    const expectedDigests: Record<
      GoldenGateFidelityDatasetKey,
      { sourceFileSha256: string; workbookCellDigestSha256: string }
    > = {
      'BsaI-HFv2': {
        sourceFileSha256: '320dd058f3ca6372768c7ddfe9cda2a2ea2a076c4f86dd08587d8f295aae1d15',
        workbookCellDigestSha256:
          'ea30b1eec9b9e3a956670d95f337661ec6beb5d97e9905927923f5d56b02c4f3',
      },
      'BsmBI-v2': {
        sourceFileSha256: '7c444e99e5e4d245461a892e8543a35c84987f93abcee7098de9d9d817237e94',
        workbookCellDigestSha256:
          '58c8327fb057a14ec5e2889b865d55632598de2332af0bce2678ed3af6e8e529',
      },
      Esp3I: {
        sourceFileSha256: '1557e62cfa4f89cd021420b75e145dae2f453ecf26dcca340a8c29008736ea66',
        workbookCellDigestSha256:
          'cc83de1d836cc42b71e0ac2daa6226aad05ff29d2ccc6f6e14d7599527ac63f0',
      },
      'BbsI-HF': {
        sourceFileSha256: '56143bb445e6d84bba646429402e0948793395269cc5d8ba0e80962c0cac6492',
        workbookCellDigestSha256:
          'f97ba640ca96731087c561bdd1a9730551ebeb45fa338a1c0841fe88dfa1f2aa',
      },
    };

    for (const [key, expected] of Object.entries(expectedDigests)) {
      const dataset = getGoldenGateFidelityDataset(key as GoldenGateFidelityDatasetKey);
      expect(dataset.overhangLength).toBe(4);
      expect(dataset.rowOverhangs).toHaveLength(256);
      expect(dataset.columnOverhangs).toHaveLength(256);
      expect(dataset.sourceFileSha256).toBe(expected.sourceFileSha256);
      expect(dataset.workbookCellDigestSha256).toBe(expected.workbookCellDigestSha256);
    }
  });

  it('maps current four-base Golden Gate enzymes and does not silently use SapI 3bp data', () => {
    expect(getGoldenGateFidelityDatasetForEnzyme('BsaI')?.key).toBe('BsaI-HFv2');
    expect(getGoldenGateFidelityDatasetForEnzyme('BsmBI')?.key).toBe('BsmBI-v2');
    expect(getGoldenGateFidelityDatasetForEnzyme('BbsI')?.key).toBe('BbsI-HF');
    expect(getGoldenGateFidelityDatasetForEnzyme('SapI')).toBeNull();
  });

  it('breaks 100% paper-fidelity ties by empirical on-target ligation count ', () => {
    const dataset = getGoldenGateFidelityDataset('BsmBI-v2');
    const current = scoreGoldenGateOverhangSet(['AGTG', 'TATT'], dataset);
    const stronger = scoreGoldenGateOverhangSet(['GTGC', 'TATT'], dataset);
    expect(current.valid).toBe(true);
    expect(stronger.valid).toBe(true);
    expect(current.fidelity).toBe(1);
    expect(stronger.fidelity).toBe(1);
    expect(stronger.onTargetCount).toBeGreaterThan(current.onTargetCount);
  });

  it('reproduces the paper-scale 81 percent fidelity for the BsmBI 11-overhang set', () => {
    const dataset = getGoldenGateFidelityDataset('BsmBI-v2');
    const plantSynBioSet = [
      'GGAG',
      'TGAC',
      'TCCC',
      'TACT',
      'CCAT',
      'AATG',
      'AGCC',
      'TTCG',
      'GCTT',
      'GGTA',
      'CGCT',
    ];

    const score = scoreGoldenGateOverhangSet(plantSynBioSet, dataset);

    expect(score.valid).toBe(true);
    expect(score.fidelity).toBeCloseTo(0.8093, 4);
    expect(score.perOverhang).toHaveLength(plantSynBioSet.length);
  });

  it('uses Watson-Crick complements and rejects non-unique sticky ends as hard conflicts', () => {
    expect(reverseComplementOverhang('GGAG')).toBe('CTCC');

    expect(findGoldenGateOverhangSetConflicts(['GGAG', 'GGAG'])).toContainEqual({
      type: 'duplicate-overhang',
      overhang: 'GGAG',
    });
    expect(findGoldenGateOverhangSetConflicts(['GGAG', 'CTCC'])).toContainEqual({
      type: 'reverse-complement-duplicate',
      overhang: 'CTCC',
      otherOverhang: 'GGAG',
    });
    expect(findGoldenGateOverhangSetConflicts(['ATAT'])).toContainEqual({
      type: 'self-complementary-overhang',
      overhang: 'ATAT',
    });
  });

  describe('palindromic overhangs (self-complementary 4-mers)', () => {
    const FOUR_MER_PALINDROMES = [
      'AATT',
      'ATAT',
      'ACGT',
      'AGCT',
      'TATA',
      'TTAA',
      'TCGA',
      'TGCA',
      'CATG',
      'CTAG',
      'CCGG',
      'CGCG',
      'GATC',
      'GTAC',
      'GCGC',
      'GGCC',
    ] as const;

    it.each(FOUR_MER_PALINDROMES)(
      'forces fidelity=0 / logFidelity=-Infinity / valid=false for palindrome %s',
      (palindrome) => {
        expect(reverseComplementOverhang(palindrome)).toBe(palindrome);

        const dataset = getGoldenGateFidelityDataset('BsaI-HFv2');
        const score = scoreGoldenGateOverhangSet([palindrome], dataset);

        expect(score.valid).toBe(false);
        expect(score.fidelity).toBe(0);
        expect(score.logFidelity).toBe(Number.NEGATIVE_INFINITY);
        expect(score.conflicts).toContainEqual({
          type: 'self-complementary-overhang',
          overhang: palindrome,
        });
        expect(score.perOverhang).toHaveLength(1);
        expect(score.perOverhang[0].overhang).toBe(palindrome);
        expect(score.perOverhang[0].correctLigations).toBe(0);
        expect(score.perOverhang[0].probability).toBe(0);
      }
    );

    it('drags a multi-overhang set to fidelity=0 when any member is palindromic', () => {
      const dataset = getGoldenGateFidelityDataset('BsaI-HFv2');
      const score = scoreGoldenGateOverhangSet(['GGAG', 'TATA', 'CCAT'], dataset);

      expect(score.valid).toBe(false);
      expect(score.fidelity).toBe(0);
      expect(score.logFidelity).toBe(Number.NEGATIVE_INFINITY);
      expect(score.conflicts).toContainEqual({
        type: 'self-complementary-overhang',
        overhang: 'TATA',
      });
      const tata = score.perOverhang.find((item) => item.overhang === 'TATA');
      expect(tata?.correctLigations).toBe(0);
      expect(tata?.probability).toBe(0);
    });
  });
});
