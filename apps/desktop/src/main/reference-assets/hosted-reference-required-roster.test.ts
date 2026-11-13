import { describe, expect, it } from 'vitest';

import {
  hostedReferenceUcscTrackTargetForAssembly,
  HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1,
} from '../../shared/hosted-reference-ucsc-targets';
import { HOSTED_REFERENCE_BUILD_CATALOG_V1 } from './hosted-reference-build-catalog';
import {
  HOSTED_REFERENCE_CATALOG_V1,
  type HostedReferenceCatalogDefinitionV1,
} from './hosted-reference-catalog';
import {
  createHostedReferenceDemandRosterV1,
  hostedReferenceDemandStatesV1,
  IGV_REFERENCE_REGISTRY_V1,
  REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1,
} from './hosted-reference-demand-catalog';

function catalogMap(
  catalog: readonly HostedReferenceCatalogDefinitionV1[]
): ReadonlyMap<string, HostedReferenceCatalogDefinitionV1> {
  return new Map(catalog.map((definition) => [definition.id, definition]));
}

describe('required hosted-reference organism and build coverage', () => {
  it('pins the approved demand portfolio to exact coordinate authorities', () => {
    expect(
      REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.map((demand) =>
        [
          demand.cohort,
          demand.id,
          demand.coordinateAuthority.provider,
          demand.coordinateAuthority.provider === 'ncbi'
            ? demand.coordinateAuthority.accession
            : demand.coordinateAuthority.genomeId,
        ].join(':')
      )
    ).toEqual([
      'core:grch38:ncbi:GCF_000001405.40',
      'core:hs1:ncbi:GCF_009914755.1',
      'core:hg19:ucsc:hg19',
      'core:mm39:ncbi:GCF_000001635.27',
      'core:mm10:ucsc:mm10',
      'core:rn8:ncbi:GCF_036323735.1',
      'core:rn7:ncbi:GCF_015227675.2',
      'core:grcz12tu:ncbi:GCF_049306965.2',
      'core:danRer11:ncbi:GCF_000002035.6',
      'core:dm6:ncbi:GCF_000001215.4',
      'core:ce11:ncbi:GCF_000002985.6',
      'core:sacCer3:ncbi:GCF_000146045.2',
      'core:pombeAsm294v3:ncbi:GCF_000002945.2',
      'core:xenTro10:ncbi:GCF_000004195.4',
      'core:xenLae10:ncbi:GCF_017654675.1',
      'core:grcg7b:ncbi:GCF_016699485.2',
      'core:canFam4:ncbi:GCF_011100685.1',
      'core:susScrHxylV2:ncbi:GCF_054392235.1',
      'core:arsUcd2:ncbi:GCF_002263795.3',
      'core:criGriPicrh1:ncbi:GCF_003668045.3',
      'comparative:t2tMmu8v2:ncbi:GCF_049350105.2',
      'comparative:t2tMfa8v11:ncbi:GCF_037993035.2',
      'comparative:rheMac10:ncbi:GCF_003339765.1',
      'comparative:mPanTro3v21:ncbi:GCF_028858775.2',
      'comparative:panTro6:ucsc:panTro6',
      'comparative:mGorGor1v21:ncbi:GCF_029281585.2',
      'comparative:mOryCun11:ncbi:GCF_964237555.1',
      'comparative:oarRambouilletV3:ncbi:GCF_016772045.2',
      'comparative:equCabTbT2t:ncbi:GCF_041296265.1',
      'comparative:medakaHdRr31:ncbi:GCF_053564925.1',
      'comparative:grcz12ab:ncbi:GCF_052040795.1',
      'comparative:galGal6:ncbi:GCF_000002315.5',
      'comparative:canFam6:ncbi:GCF_000002285.5',
      'comparative:canFam3:ncbi:GCF_000002285.3',
      'comparative:susScr11:ncbi:GCF_000003025.6',
      'comparative:bosTau9:ncbi:GCF_002263795.1',
      'comparative:pomBase:ncbi:GCF_000002945.1',
      'comparative:smedA2h1:ncbi:GCA_057920485.1',
      'plants:tair10:ncbi:GCF_000001735.4',
      'plants:agis1:ncbi:GCF_034140825.1',
      'plants:irgsp1:ncbi:GCF_001433935.1',
      'plants:zmB73v5:ncbi:GCF_902167145.1',
      'plants:sbicolorNcbiv3:ncbi:GCF_000003195.3',
      'plants:ntK326:ncbi:GCF_000715075.1',
      'plants:nibenKlab:ncbi:GCA_034376525.1',
      'plants:spirodelaPolyrhiza:ncbi:GCA_060665495.1',
      'plants:tomatoSlmR21:ncbi:GCF_036512215.1',
      'plants:soybeanV4:ncbi:GCF_000004515.6',
      'plants:wheatRefseqV21:ncbi:GCF_018294505.1',
      'microbes:ecoliK12Mg1655:ncbi:GCF_000005845.2',
      'microbes:ecoliBl21De3:ncbi:GCF_000022665.1',
      'microbes:bacillus168:ncbi:GCF_000009045.1',
      'microbes:pputidaKt2440:ncbi:GCF_000007565.2',
      'microbes:cglutamicumAtcc13032:ncbi:GCF_000011325.1',
      'microbes:scoelicolorA32:ncbi:GCF_000203835.1',
      'microbes:kphaffiiGs115:ncbi:GCF_000027005.1',
      'microbes:kphaffiiCbs7435:ncbi:GCA_000223565.1',
      'microbes:candidaSC5314:ncbi:GCF_000182965.3',
      'microbes:anidulansFgscA4:ncbi:GCF_000011425.1',
      'microbes:mtbH37Rv:ncbi:GCF_000195955.2',
      'microbes:paeruginosaPao1:ncbi:GCF_000006765.1',
      'microbes:saureusNctc8325:ncbi:GCF_000013425.1',
      'microbes:saureusUsa300Fpr3757:ncbi:GCA_000013465.1',
      'microbes:salmonellaLt2:ncbi:GCF_000006945.2',
      'microbes:sarsCov2WuhanHu1:ncbi:GCF_009858895.2',
      'microbes:pfalciparum3d7:ncbi:GCF_000002765.6',
      'microbes:agambiaeF1:ncbi:GCF_943734735.2',
    ]);
  });

  it('keeps cohort counts and the current IGV-Web registry explicit', () => {
    const cohortCounts = Object.fromEntries(
      ['core', 'comparative', 'plants', 'microbes'].map((cohort) => [
        cohort,
        REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.filter((demand) => demand.cohort === cohort)
          .length,
      ])
    );

    expect(cohortCounts).toEqual({ core: 20, comparative: 18, plants: 11, microbes: 18 });
    expect(
      REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.filter(
        ({ coordinateAuthority }) => coordinateAuthority.provider === 'ncbi'
      )
    ).toHaveLength(64);
    expect(
      REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.filter(
        ({ coordinateAuthority }) => coordinateAuthority.provider === 'ucsc'
      )
    ).toHaveLength(3);
    expect(IGV_REFERENCE_REGISTRY_V1).toBe('https://igv.org/app/resources/genomes.json');
    expect(
      REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.flatMap(({ igvGenomeId }) =>
        igvGenomeId ? [igvGenomeId] : []
      )
    ).toEqual([
      'hg38',
      'hs1',
      'hg19',
      'mm39',
      'mm10',
      'rn7',
      'danRer11',
      'dm6',
      'ce11',
      'sacCer3',
      'GCF_016699485.2',
      'canFam4',
      'panTro6',
      'galGal6',
      'canFam6',
      'canFam3',
      'susScr11',
      'bosTau9',
      'tair10',
      'GCF_001433935.1',
      'ASM985889v3',
    ]);
  });

  it('keeps the UCSC target projection in exact demand-roster parity', () => {
    expect(HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1.map(({ id }) => id)).toEqual(
      REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.map(({ id }) => id)
    );
    expect(
      HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1.filter(({ target }) => target === null).map(
        ({ id }) => id
      )
    ).toEqual([
      't2tMfa8v11',
      'grcz12ab',
      'smedA2h1',
      'nibenKlab',
      'spirodelaPolyrhiza',
      'scoelicolorA32',
      'kphaffiiCbs7435',
      'saureusUsa300Fpr3757',
    ]);
    expect(hostedReferenceUcscTrackTargetForAssembly('grcz12tu')).toEqual({
      genomeId: 'GCF_049306965.2',
    });
    expect(hostedReferenceUcscTrackTargetForAssembly('GRCz12tu')).toBeNull();
    expect(hostedReferenceUcscTrackTargetForAssembly('GCF_049306965.1')).toBeNull();

    for (const definition of HOSTED_REFERENCE_BUILD_CATALOG_V1) {
      expect(
        HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1.some(({ id }) => id === definition.id),
        `${definition.id} must have an explicit UCSC target or explicit null`
      ).toBe(true);
    }
    for (const definition of HOSTED_REFERENCE_CATALOG_V1) {
      expect(
        HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1.some(({ id }) => id === definition.id),
        `${definition.id} must project through the same UCSC target authority`
      ).toBe(true);
    }
  });

  it('rejects duplicate DNAForge IDs, coordinate authorities, and IGV aliases', () => {
    const first = REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1[0]!;
    const second = REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1[1]!;

    expect(() => createHostedReferenceDemandRosterV1([first, first])).toThrow(/ID is duplicated/);
    expect(() =>
      createHostedReferenceDemandRosterV1([
        first,
        { ...second, id: 'different-id', coordinateAuthority: first.coordinateAuthority },
      ])
    ).toThrow(/coordinate authority is duplicated/);
    expect(() =>
      createHostedReferenceDemandRosterV1([
        first,
        { ...second, id: 'different-id', igvGenomeId: first.igvGenomeId },
      ])
    ).toThrow(/IGV genome ID is duplicated/);
  });

  it('reports the current requested roster as prepared, source-published, or not published', () => {
    const states = hostedReferenceDemandStatesV1();

    expect(
      states.filter(({ availability }) => availability === 'prepared').map(({ id }) => id)
    ).toEqual([
      'grch38',
      'hs1',
      'hg19',
      'mm39',
      'mm10',
      'rn8',
      'rn7',
      'grcz12tu',
      'danRer11',
      'dm6',
      'ce11',
      'sacCer3',
      'pombeAsm294v3',
      'xenTro10',
      'xenLae10',
      'grcg7b',
      'canFam4',
      'susScrHxylV2',
      'arsUcd2',
      'criGriPicrh1',
      't2tMmu8v2',
      't2tMfa8v11',
      'rheMac10',
      'mPanTro3v21',
      'panTro6',
      'mGorGor1v21',
      'mOryCun11',
      'oarRambouilletV3',
      'equCabTbT2t',
      'medakaHdRr31',
      'grcz12ab',
      'galGal6',
      'canFam6',
      'canFam3',
      'susScr11',
      'bosTau9',
      'pomBase',
      'tair10',
      'agis1',
      'irgsp1',
      'zmB73v5',
      'sbicolorNcbiv3',
      'ntK326',
      'nibenKlab',
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
      'saureusUsa300Fpr3757',
      'salmonellaLt2',
      'sarsCov2WuhanHu1',
      'pfalciparum3d7',
      'agambiaeF1',
    ]);
    expect(
      states.filter(({ availability }) => availability === 'source-published').map(({ id }) => id)
    ).toEqual([]);
    expect(
      states.filter(({ availability }) => availability === 'not-published').map(({ id }) => id)
    ).toEqual(['smedA2h1', 'spirodelaPolyrhiza']);
  });

  it('derives readiness only from authenticated source and prepared-publication authority', () => {
    const buildCatalog = catalogMap(HOSTED_REFERENCE_BUILD_CATALOG_V1);
    const runtimeCatalog = catalogMap(HOSTED_REFERENCE_CATALOG_V1);

    for (const state of hostedReferenceDemandStatesV1()) {
      const definition = buildCatalog.get(state.id);

      if (state.availability === 'not-published') {
        expect(definition, `${state.id} must not invent hosted source authority`).toBeUndefined();
        expect(runtimeCatalog.has(state.id), `${state.id} must not be advertised as ready`).toBe(
          false
        );
        continue;
      }

      expect(definition, `${state.id} must have an admitted source definition`).toBeDefined();
      expect(definition?.sources.fasta.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(definition?.sources.annotations.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(definition?.sources.fasta.byteLength).toBeGreaterThan(0);
      expect(definition?.sources.annotations.byteLength).toBeGreaterThan(0);
      expect(definition?.contigs.length).toBeGreaterThan(0);
      expect(definition?.contigs.every(({ lengthBp }) => lengthBp > 0)).toBe(true);

      if (state.availability === 'source-published') {
        expect(definition?.preparedBundle).toBeUndefined();
        expect(
          runtimeCatalog.has(state.id),
          `${state.id} has raw sources but no prepared publication and must remain hidden`
        ).toBe(false);
        continue;
      }

      expect(definition?.preparedBundle).toBeDefined();
      expect(
        runtimeCatalog.get(state.id),
        `${state.id} has a prepared publication and must project through the runtime catalog`
      ).toBe(definition);
    }

    expect(HOSTED_REFERENCE_CATALOG_V1).toHaveLength(
      HOSTED_REFERENCE_BUILD_CATALOG_V1.filter(({ preparedBundle }) => preparedBundle !== undefined)
        .length
    );
  });
});
