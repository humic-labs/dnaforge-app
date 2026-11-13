import type { HostedReferencePreparedCatalogDefinitionV1 } from './hosted-reference-catalog-types';
import type { HostedReferencePreparedBundleAssetV1 } from './hosted-reference-prepared-bundle-contract';
import {
  AGIS1_PRIMARY_CONTIGS,
  DM6_PRIMARY_CONTIGS,
  EQU_CAB_TBT2T_PRIMARY_CONTIGS,
  GRCZ12TU_PRIMARY_CONTIGS,
  MAIZE_NAM5_PRIMARY_CONTIGS,
  MGORGOR1V21_PRIMARY_CONTIGS,
  MM39_PRIMARY_CONTIGS,
  MORYCUN11_PRIMARY_CONTIGS,
  MPANTRO3V21_PRIMARY_CONTIGS,
  OAR_RAMBOUILLET_V3_PRIMARY_CONTIGS,
  RHEMAC10_PRIMARY_CONTIGS,
  T2T_MMU8V2_PRIMARY_CONTIGS,
  TAIR10_PRIMARY_CONTIGS,
  XENTRO10_PRIMARY_CONTIGS,
} from './hosted-reference-primary-contigs';
import {
  AGIS1_PREPARED_BUNDLE_V1,
  DM6_PREPARED_BUNDLE_V1,
  GRCZ12TU_PREPARED_BUNDLE_V1,
  MM39_PREPARED_BUNDLE_V1,
  XENTRO10_PREPARED_BUNDLE_V1,
  ZMB73V5_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications';
import {
  EQU_CAB_TB_T2T_PREPARED_BUNDLE_V1,
  M_GOR_GOR1V21_PREPARED_BUNDLE_V1,
  M_ORY_CUN11_PREPARED_BUNDLE_V1,
  M_PAN_TRO3V21_PREPARED_BUNDLE_V1,
  OAR_RAMBOUILLET_V3_PREPARED_BUNDLE_V1,
  RHE_MAC10_PREPARED_BUNDLE_V1,
  T2T_MMU8V2_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications-wave04';
import {
  CAN_FAM4_PREPARED_BUNDLE_V1,
  DAN_RER11_PREPARED_BUNDLE_V1,
  GRCG7B_PREPARED_BUNDLE_V1,
  HS1_PREPARED_BUNDLE_V1,
  POMBE_ASM294V3_PREPARED_BUNDLE_V1,
  RN7_PREPARED_BUNDLE_V1,
  RN8_PREPARED_BUNDLE_V1,
  XEN_LAE10_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications-wave05';
import {
  ARS_UCD2_PREPARED_BUNDLE_V1,
  CRI_GRI_PICRH1_PREPARED_BUNDLE_V1,
  GRCZ12AB_PREPARED_BUNDLE_V1,
  HG19_PREPARED_BUNDLE_V1,
  MEDAKA_HD_RR31_PREPARED_BUNDLE_V1,
  MM10_PREPARED_BUNDLE_V1,
  PAN_TRO6_PREPARED_BUNDLE_V1,
  SUS_SCR_HXYL_V2_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications-public-data-wave01';
import {
  BOS_TAU9_PREPARED_BUNDLE_V1,
  CAN_FAM3_PREPARED_BUNDLE_V1,
  CAN_FAM6_PREPARED_BUNDLE_V1,
  GAL_GAL6_PREPARED_BUNDLE_V1,
  POM_BASE_PREPARED_BUNDLE_V1,
  SUS_SCR11_PREPARED_BUNDLE_V1,
  TOMATO_SLM_R21_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications-public-data-wave02';
import {
  AGAMBIAE_F1_PREPARED_BUNDLE_V1,
  ANIDULANS_FGSC_A4_PREPARED_BUNDLE_V1,
  CANDIDA_SC5314_PREPARED_BUNDLE_V1,
  IRGSP1_PREPARED_BUNDLE_V1,
  KPHAFFII_CBS7435_PREPARED_BUNDLE_V1,
  KPHAFFII_GS115_PREPARED_BUNDLE_V1,
  NT_K326_PREPARED_BUNDLE_V1,
  PFALCIPARUM3D7_PREPARED_BUNDLE_V1,
  SOYBEAN_V4_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications-public-data-wave03';
import {
  SBICOLOR_NCBIV3_PREPARED_BUNDLE_V1,
  T2T_MFA8V11_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications-public-data-extra-demand';
import { WHEAT_REFSEQ_V21_PREPARED_BUNDLE_V1 } from './hosted-reference-prepared-publications-public-data-wheat';
import { SARS_COV2_WUHAN_HU1_PREPARED_BUNDLE_V1 } from './hosted-reference-prepared-publications-public-data-sars';
import { NIBEN_KLAB_PREPARED_BUNDLE_V1 } from './hosted-reference-prepared-publications-public-data-niben';
import {
  BACILLUS168_PREPARED_BUNDLE_V1,
  CGLUTAMICUM_ATCC13032_PREPARED_BUNDLE_V1,
  ECOLI_BL21_DE3_PREPARED_BUNDLE_V1,
  ECOLI_K12_MG1655_PREPARED_BUNDLE_V1,
  MTB_H37_RV_PREPARED_BUNDLE_V1,
  PAERUGINOSA_PAO1_PREPARED_BUNDLE_V1,
  PPUTIDA_KT2440_PREPARED_BUNDLE_V1,
  SALMONELLA_LT2_PREPARED_BUNDLE_V1,
  SAUREUS_NCTC8325_PREPARED_BUNDLE_V1,
  SAUREUS_USA300_FPR3757_PREPARED_BUNDLE_V1,
  SCOELICOLOR_A32_PREPARED_BUNDLE_V1,
} from './hosted-reference-prepared-publications-public-data-bacteria';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_WAVE05_V1 } from './hosted-reference-rollout-source-catalog-wave05';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE01_V1 } from './hosted-reference-rollout-source-catalog-public-data-wave01';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE02_V1 } from './hosted-reference-rollout-source-catalog-public-data-wave02';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE03_V1 } from './hosted-reference-rollout-source-catalog-public-data-wave03';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_EXTRA_DEMAND_V1 } from './hosted-reference-rollout-source-catalog-public-data-extra-demand';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WHEAT_V1 } from './hosted-reference-rollout-source-catalog-public-data-wheat';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_SARS_V1 } from './hosted-reference-rollout-source-catalog-public-data-sars';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_BACTERIA_V1 } from './hosted-reference-rollout-source-catalog-public-data-bacteria';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1 } from './hosted-reference-rollout-source-catalog-public-data-niben';

const HOSTED_REFERENCE_ROLLOUT_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_WAVE05_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  hs1: HS1_PREPARED_BUNDLE_V1,
  rn8: RN8_PREPARED_BUNDLE_V1,
  rn7: RN7_PREPARED_BUNDLE_V1,
  danRer11: DAN_RER11_PREPARED_BUNDLE_V1,
  pombeAsm294v3: POMBE_ASM294V3_PREPARED_BUNDLE_V1,
  xenLae10: XEN_LAE10_PREPARED_BUNDLE_V1,
  grcg7b: GRCG7B_PREPARED_BUNDLE_V1,
  canFam4: CAN_FAM4_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_WAVE01_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE01_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  hg19: HG19_PREPARED_BUNDLE_V1,
  mm10: MM10_PREPARED_BUNDLE_V1,
  susScrHxylV2: SUS_SCR_HXYL_V2_PREPARED_BUNDLE_V1,
  arsUcd2: ARS_UCD2_PREPARED_BUNDLE_V1,
  criGriPicrh1: CRI_GRI_PICRH1_PREPARED_BUNDLE_V1,
  panTro6: PAN_TRO6_PREPARED_BUNDLE_V1,
  medakaHdRr31: MEDAKA_HD_RR31_PREPARED_BUNDLE_V1,
  grcz12ab: GRCZ12AB_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_WAVE02_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE02_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  galGal6: GAL_GAL6_PREPARED_BUNDLE_V1,
  canFam6: CAN_FAM6_PREPARED_BUNDLE_V1,
  canFam3: CAN_FAM3_PREPARED_BUNDLE_V1,
  susScr11: SUS_SCR11_PREPARED_BUNDLE_V1,
  bosTau9: BOS_TAU9_PREPARED_BUNDLE_V1,
  pomBase: POM_BASE_PREPARED_BUNDLE_V1,
  tomatoSlmR21: TOMATO_SLM_R21_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_WAVE03_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE03_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  irgsp1: IRGSP1_PREPARED_BUNDLE_V1,
  soybeanV4: SOYBEAN_V4_PREPARED_BUNDLE_V1,
  ntK326: NT_K326_PREPARED_BUNDLE_V1,
  kphaffiiGs115: KPHAFFII_GS115_PREPARED_BUNDLE_V1,
  kphaffiiCbs7435: KPHAFFII_CBS7435_PREPARED_BUNDLE_V1,
  candidaSC5314: CANDIDA_SC5314_PREPARED_BUNDLE_V1,
  anidulansFgscA4: ANIDULANS_FGSC_A4_PREPARED_BUNDLE_V1,
  pfalciparum3d7: PFALCIPARUM3D7_PREPARED_BUNDLE_V1,
  agambiaeF1: AGAMBIAE_F1_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_EXTRA_DEMAND_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_EXTRA_DEMAND_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  t2tMfa8v11: T2T_MFA8V11_PREPARED_BUNDLE_V1,
  sbicolorNcbiv3: SBICOLOR_NCBIV3_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_WHEAT_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WHEAT_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  wheatRefseqV21: WHEAT_REFSEQ_V21_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_SARS_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_SARS_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  sarsCov2WuhanHu1: SARS_COV2_WUHAN_HU1_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_BACTERIA_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_BACTERIA_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  ecoliK12Mg1655: ECOLI_K12_MG1655_PREPARED_BUNDLE_V1,
  ecoliBl21De3: ECOLI_BL21_DE3_PREPARED_BUNDLE_V1,
  bacillus168: BACILLUS168_PREPARED_BUNDLE_V1,
  pputidaKt2440: PPUTIDA_KT2440_PREPARED_BUNDLE_V1,
  cglutamicumAtcc13032: CGLUTAMICUM_ATCC13032_PREPARED_BUNDLE_V1,
  scoelicolorA32: SCOELICOLOR_A32_PREPARED_BUNDLE_V1,
  mtbH37Rv: MTB_H37_RV_PREPARED_BUNDLE_V1,
  paeruginosaPao1: PAERUGINOSA_PAO1_PREPARED_BUNDLE_V1,
  saureusNctc8325: SAUREUS_NCTC8325_PREPARED_BUNDLE_V1,
  salmonellaLt2: SALMONELLA_LT2_PREPARED_BUNDLE_V1,
  saureusUsa300Fpr3757: SAUREUS_USA300_FPR3757_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_DNA2817_NIBEN_PREPARED_BUNDLES_V1: Readonly<
  Record<
    (typeof HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1)[number]['id'],
    HostedReferencePreparedBundleAssetV1
  >
> = Object.freeze({
  nibenKlab: NIBEN_KLAB_PREPARED_BUNDLE_V1,
});

const HOSTED_REFERENCE_PREPARED_BUNDLE_BY_ID_V1: Readonly<
  Record<string, HostedReferencePreparedBundleAssetV1>
> = Object.freeze({
  ...HOSTED_REFERENCE_ROLLOUT_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_WAVE01_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_WAVE02_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_WAVE03_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_SARS_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_EXTRA_DEMAND_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_WHEAT_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_BACTERIA_PREPARED_BUNDLES_V1,
  ...HOSTED_REFERENCE_DNA2817_NIBEN_PREPARED_BUNDLES_V1,
});

const HOSTED_REFERENCE_PREPARED_SOURCE_CATALOGS_V1 = [
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_WAVE05_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE01_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE02_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WAVE03_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_SARS_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_EXTRA_DEMAND_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_WHEAT_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_BACTERIA_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1,
] as const;

const HOSTED_REFERENCE_SOURCE_BY_ID_V1 = new Map(
  HOSTED_REFERENCE_PREPARED_SOURCE_CATALOGS_V1.map(
    (definition) => [definition.id, definition] as const
  )
);

const HOSTED_REFERENCE_HARDCODED_ROLLOUT_IDS_V1 = new Set([
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
]);

export const HOSTED_REFERENCE_ROLLOUT_CATALOG_V1: ReadonlyArray<HostedReferencePreparedCatalogDefinitionV1> =
  Object.freeze([
    Object.freeze({
      id: 'mm39',
      name: 'GRCm39 (mouse)',
      organism: 'Mus musculus',
      taxId: 10_090,
      assembly: 'GRCm39',
      description:
        'Mouse GRCm39 reference — primary chromosomes with searchable NCBI RefSeq annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'mm39/GCF_000001635.27/3185b185d83de72a/GCF_000001635.27_GRCm39_primary.fna.gz',
          sha256: '3185b185d83de72aacab15b247ed5734982b657fc0be8b26fc3c14fed578f1fa',
          byteLength: 831_488_844,
        }),
        annotations: Object.freeze({
          relativePath:
            'mm39/GCF_000001635.27/0f0a0e4aa69a22dc/GCF_000001635.27_GRCm39_primary.gff3.gz',
          sha256: '0f0a0e4aa69a22dc4bae0d4d1b5d224c0a439c3fcc705869fae76ad681230a35',
          byteLength: 43_644_682,
        }),
      }),
      preparedBundle: MM39_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_000001635.27',
        datasetVersion: 'GCF_000001635.27-RS_2024_02',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001635.27/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: MM39_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'grcz12tu',
      name: 'GRCz12tu (zebrafish)',
      organism: 'Danio rerio',
      taxId: 7_955,
      assembly: 'GRCz12tu',
      description:
        'Zebrafish GRCz12tu reference — primary chromosomes with searchable NCBI RefSeq annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'grcz12tu/GCF_049306965.2/c684d7b71548a141/GCF_049306965.2_GRCz12tu_primary.fna.gz',
          sha256: 'c684d7b71548a141551710c3f2edfa77f7591028a6ad2297d9e3a43b708c8982',
          byteLength: 434_953_682,
        }),
        annotations: Object.freeze({
          relativePath:
            'grcz12tu/GCF_049306965.2/3515f63aab87a5ad/GCF_049306965.2_GRCz12tu_primary.gff3.gz',
          sha256: '3515f63aab87a5ad5b8ff6b138d2d9357d4431551501e1a5dbf29252a52e48a3',
          byteLength: 38_881_633,
        }),
      }),
      preparedBundle: GRCZ12TU_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_049306965.2',
        datasetVersion: 'GCF_049306965.1-RS_2025_04',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_049306965.2/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: GRCZ12TU_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'dm6',
      name: 'D. melanogaster (dm6)',
      organism: 'Drosophila melanogaster',
      taxId: 7_227,
      assembly: 'dm6',
      description:
        'Fruit fly dm6 reference — primary chromosomes with searchable FlyBase annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 'dm6/GCF_000001215.4/e02cee38083b5fec/GCF_000001215.4_dm6_primary.fna.gz',
          sha256: 'e02cee38083b5fecf0819185f1ed236d94f6f08896db5968bddc4d7a6351e990',
          byteLength: 42_673_573,
        }),
        annotations: Object.freeze({
          relativePath: 'dm6/GCF_000001215.4/ae77e6aefd60c0e5/GCF_000001215.4_dm6_primary.gff3.gz',
          sha256: 'ae77e6aefd60c0e513ed77a882b587d57dc17b43d98b78a1b21a3da3f4d636dd',
          byteLength: 8_600_288,
        }),
      }),
      preparedBundle: DM6_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'FlyBase',
        datasetId: 'GCF_000001215.4',
        datasetVersion: 'FlyBase Release 6.54',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001215.4/',
        license: 'NCBI public-domain data',
        attribution: 'FlyBase; National Center for Biotechnology Information (NCBI)',
      }),
      contigs: DM6_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'xenTro10',
      name: 'X. tropicalis (xenTro10)',
      organism: 'Xenopus tropicalis',
      taxId: 8_369,
      assembly: 'UCB_Xtro_10.0',
      description:
        'Western clawed frog UCB_Xtro_10.0 reference — primary chromosomes with searchable NCBI RefSeq annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'xenTro10/GCF_000004195.4/caeeff933dd13808/GCF_000004195.4_UCB_Xtro_10.0_primary.fna.gz',
          sha256: 'caeeff933dd138086456e9b5d774729ad9e26794b49a3527ac522fbde5f2f7cf',
          byteLength: 431_042_563,
        }),
        annotations: Object.freeze({
          relativePath:
            'xenTro10/GCF_000004195.4/eedbc5ab1f7a4bc9/GCF_000004195.4_UCB_Xtro_10.0_primary.gff3.gz',
          sha256: 'eedbc5ab1f7a4bc980d86c0e2523a5ed29fb92005b453e1138c5eb589f8b61d0',
          byteLength: 17_445_280,
        }),
      }),
      preparedBundle: XENTRO10_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_000004195.4',
        datasetVersion: 'NCBI Annotation Release 104',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000004195.4/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: XENTRO10_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'tair10',
      name: 'A. thaliana (TAIR10.1)',
      organism: 'Arabidopsis thaliana',
      taxId: 3_702,
      assembly: 'TAIR10.1',
      description:
        'Arabidopsis TAIR10.1 reference — primary nuclear chromosomes with searchable TAIR and Araport annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'tair10/GCF_000001735.4/af518a561a710416/GCF_000001735.4_TAIR10.1_primary.fna.gz',
          sha256: 'af518a561a710416597b362610656aea4b5c53d1bedf73c420bef1ffaf10f73b',
          byteLength: 37_258_831,
        }),
        annotations: Object.freeze({
          relativePath:
            'tair10/GCF_000001735.4/13eb73d29cce948b/GCF_000001735.4_TAIR10.1_primary.gff3.gz',
          sha256: '13eb73d29cce948b7f9a80aaa18173914c07d5bfae015e6e86b7f1ccbdad8e80',
          byteLength: 22_134_742,
        }),
      }),
      preparedBundle: Object.freeze({
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
      } as const),
      provenance: Object.freeze({
        provider: 'TAIR/Araport',
        datasetId: 'GCF_000001735.4',
        datasetVersion: 'Annotation submitted by TAIR and Araport (2022-10-20)',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001735.4/',
        license: 'NCBI public-domain data',
        attribution:
          'The Arabidopsis Information Resource (TAIR), Araport, and National Center for Biotechnology Information (NCBI)',
      }),
      contigs: TAIR10_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'agis1',
      name: 'O. sativa (AGIS1.0)',
      organism: 'Oryza sativa',
      taxId: 4_530,
      assembly: 'AGIS1.0',
      description:
        'Asian rice AGIS1.0 reference — primary nuclear chromosomes with searchable NCBI RefSeq annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'agis1/GCF_034140825.1/3c2bb9240ef89731/GCF_034140825.1_AGIS1.0_primary.fna.gz',
          sha256: '3c2bb9240ef8973144e945872b31af591dfa55c4587b128b41bea1bb3795465b',
          byteLength: 119_872_257,
        }),
        annotations: Object.freeze({
          relativePath:
            'agis1/GCF_034140825.1/b1837ac52c65292f/GCF_034140825.1_AGIS1.0_primary.gff3.gz',
          sha256: 'b1837ac52c65292fa1c28c64ace8c05a81c54e535cf54c7fa4186a1f4695992b',
          byteLength: 11_336_814,
        }),
      }),
      preparedBundle: AGIS1_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_034140825.1',
        datasetVersion: 'GCF_034140825.1-RS_2024_06',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_034140825.1/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: AGIS1_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'zmB73v5',
      name: 'Z. mays B73 (NAM-5.0)',
      organism: 'Zea mays',
      taxId: 4_577,
      assembly: 'NAM-5.0',
      description:
        'Maize B73 NAM-5.0 reference — primary nuclear chromosomes with searchable NCBI RefSeq annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'zmB73v5/GCF_902167145.1/4627fdd2b5afb5f5/GCF_902167145.1_NAM_5.0_primary.fna.gz',
          sha256: '4627fdd2b5afb5f5ee5659c2f43e983ce309e65457a9fb6ae2265e902b05dc0f',
          byteLength: 639_752_083,
        }),
        annotations: Object.freeze({
          relativePath:
            'zmB73v5/GCF_902167145.1/40052a527b5b8bbf/GCF_902167145.1_NAM_5.0_primary.gff3.gz',
          sha256: '40052a527b5b8bbf7460a7c937521a6bdd7450b7174605b3a76731bcf2dd6d45',
          byteLength: 15_816_410,
        }),
      }),
      preparedBundle: ZMB73V5_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_902167145.1',
        datasetVersion: 'GCF_902167145.1-RS_2025_02',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_902167145.1/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: MAIZE_NAM5_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 't2tMmu8v2',
      name: 'T2T-MMU8v2.0 (rhesus macaque)',
      organism: 'Macaca mulatta',
      taxId: 9_544,
      assembly: 'T2T-MMU8v2.0',
      description:
        'Exact T2T-MMU8v2.0 Macaca mulatta reference — NCBI RefSeq assembled molecules with searchable annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 't2tMmu8v2/GCF_049350105.2/cb667b37d58cd5b7/GCF_049350105.2_primary.fna',
          sha256: 'cb667b37d58cd5b7146c6ee081683c1c56bc9c39cdb712782a24a873f27fb7a3',
          byteLength: 3_154_061_906,
        }),
        annotations: Object.freeze({
          relativePath: 't2tMmu8v2/GCF_049350105.2/ec5be862bba7e4d0/GCF_049350105.2_primary.gff3',
          sha256: 'ec5be862bba7e4d0749e2e57aa9d128551d8fbbc850587ce112ab565d78feb11',
          byteLength: 1_079_579_154,
        }),
      }),
      preparedBundle: T2T_MMU8V2_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_049350105.2',
        datasetVersion: 'T2T-MMU8v2.0',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_049350105.2/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: T2T_MMU8V2_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'rheMac10',
      name: 'Mmul_10 (rhesus macaque)',
      organism: 'Macaca mulatta',
      taxId: 9_544,
      assembly: 'Mmul_10',
      description:
        'Exact Mmul_10 Macaca mulatta reference — NCBI RefSeq assembled molecules with searchable annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 'rheMac10/GCF_003339765.1/ee3f2e50f2e5e97e/GCF_003339765.1_primary.fna',
          sha256: 'ee3f2e50f2e5e97e06bb5b5b4268c47756d2750ee825d3ac91c11de9af2f9036',
          byteLength: 2_889_670_017,
        }),
        annotations: Object.freeze({
          relativePath: 'rheMac10/GCF_003339765.1/48a4f1723e005378/GCF_003339765.1_primary.gff3',
          sha256: '48a4f1723e0053780fe69ffc6cfa8cc2f9e53da5b2f2dba2c007792e83f18cd7',
          byteLength: 559_605_255,
        }),
      }),
      preparedBundle: RHE_MAC10_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_003339765.1',
        datasetVersion: 'Mmul_10',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_003339765.1/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: RHEMAC10_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'mPanTro3v21',
      name: 'NHGRI mPanTro3 v2.1 (chimpanzee)',
      organism: 'Pan troglodytes',
      taxId: 9_598,
      assembly: 'NHGRI_mPanTro3-v2.1_pri',
      description:
        'Exact NHGRI_mPanTro3-v2.1_pri Pan troglodytes reference — NCBI RefSeq assembled molecules with searchable annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 'mPanTro3v21/GCF_028858775.2/01376b85cfbe6c4f/GCF_028858775.2_primary.fna',
          sha256: '01376b85cfbe6c4f569078095a61a793ceacb928a4d6b797e4c53c7c117a0f6e',
          byteLength: 3_217_481_210,
        }),
        annotations: Object.freeze({
          relativePath: 'mPanTro3v21/GCF_028858775.2/aaba8ba29d2081a8/GCF_028858775.2_primary.gff3',
          sha256: 'aaba8ba29d2081a8ccdc170d1196e0c33023fd4072456e3c1a530c318d8d5c89',
          byteLength: 1_049_847_869,
        }),
      }),
      preparedBundle: M_PAN_TRO3V21_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_028858775.2',
        datasetVersion: 'NHGRI_mPanTro3-v2.1_pri',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_028858775.2/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: MPANTRO3V21_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'mGorGor1v21',
      name: 'NHGRI mGorGor1 v2.1 (gorilla)',
      organism: 'Gorilla gorilla gorilla',
      taxId: 9_595,
      assembly: 'NHGRI_mGorGor1-v2.1_pri',
      description:
        'Exact NHGRI_mGorGor1-v2.1_pri Gorilla gorilla gorilla reference — NCBI RefSeq assembled molecules with searchable annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 'mGorGor1v21/GCF_029281585.2/b828375c433f77c0/GCF_029281585.2_primary.fna',
          sha256: 'b828375c433f77c0292361c73f3dd31e98e5cd804663b3c162245a6325213508',
          byteLength: 3_590_176_889,
        }),
        annotations: Object.freeze({
          relativePath: 'mGorGor1v21/GCF_029281585.2/93332a5c08ea6635/GCF_029281585.2_primary.gff3',
          sha256: '93332a5c08ea6635a87e8f4617ea5c280fdef86192b9ea9fe3b938183f620eac',
          byteLength: 692_638_627,
        }),
      }),
      preparedBundle: M_GOR_GOR1V21_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_029281585.2',
        datasetVersion: 'NHGRI_mGorGor1-v2.1_pri',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_029281585.2/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: MGORGOR1V21_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'mOryCun11',
      name: 'mOryCun1.1 (rabbit)',
      organism: 'Oryctolagus cuniculus',
      taxId: 9_986,
      assembly: 'mOryCun1.1',
      description:
        'Exact mOryCun1.1 Oryctolagus cuniculus reference — NCBI RefSeq assembled molecules with searchable annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 'mOryCun11/GCF_964237555.1/f24f1b8720007327/GCF_964237555.1_primary.fna',
          sha256: 'f24f1b87200073273531c26c0fd6d201697b8cf343419b6d4893f94f5762f0e2',
          byteLength: 2_777_603_833,
        }),
        annotations: Object.freeze({
          relativePath: 'mOryCun11/GCF_964237555.1/dc8580a3222cfde3/GCF_964237555.1_primary.gff3',
          sha256: 'dc8580a3222cfde39e4fe4e73ad7e2f008c1567b9e6f28b41bcd178fc34c40e5',
          byteLength: 694_963_984,
        }),
      }),
      preparedBundle: M_ORY_CUN11_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_964237555.1',
        datasetVersion: 'mOryCun1.1',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_964237555.1/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: MORYCUN11_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'oarRambouilletV3',
      name: 'ARS-UI Rambouillet v3.0 (sheep)',
      organism: 'Ovis aries',
      taxId: 9_940,
      assembly: 'ARS-UI_Ramb_v3.0',
      description:
        'Exact ARS-UI_Ramb_v3.0 Ovis aries reference — NCBI RefSeq assembled molecules with searchable annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath:
            'oarRambouilletV3/GCF_016772045.2/4676028b1a68b41e/GCF_016772045.2_primary.fna',
          sha256: '4676028b1a68b41e56dd6e525560805d3db320f54f783a94ee8898db30242f3e',
          byteLength: 2_674_606_512,
        }),
        annotations: Object.freeze({
          relativePath:
            'oarRambouilletV3/GCF_016772045.2/456ff3f9116d3551/GCF_016772045.2_primary.gff3',
          sha256: '456ff3f9116d3551796cb68a1af4cf77d7061735b93f01fbef4d62e41b2edda4',
          byteLength: 732_658_886,
        }),
      }),
      preparedBundle: OAR_RAMBOUILLET_V3_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_016772045.2',
        datasetVersion: 'ARS-UI_Ramb_v3.0',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_016772045.2/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: OAR_RAMBOUILLET_V3_PRIMARY_CONTIGS,
    }),
    Object.freeze({
      id: 'equCabTbT2t',
      name: 'TB-T2T (horse)',
      organism: 'Equus caballus',
      taxId: 9_796,
      assembly: 'TB-T2T',
      description:
        'Exact TB-T2T Equus caballus reference — NCBI RefSeq assembled molecules with searchable annotations.',
      sources: Object.freeze({
        fasta: Object.freeze({
          relativePath: 'equCabTbT2t/GCF_041296265.1/24482aea51b7584e/GCF_041296265.1_primary.fna',
          sha256: '24482aea51b7584e00c25511d459fd070cb66a43ce14428a0a69405a6526d941',
          byteLength: 2_717_135_912,
        }),
        annotations: Object.freeze({
          relativePath: 'equCabTbT2t/GCF_041296265.1/db3240f486c8379e/GCF_041296265.1_primary.gff3',
          sha256: 'db3240f486c8379e85dbdcb20c5871edccf51d84b4f5bb6bb68b3031a2ef0a92',
          byteLength: 963_797_859,
        }),
      }),
      preparedBundle: EQU_CAB_TB_T2T_PREPARED_BUNDLE_V1,
      provenance: Object.freeze({
        provider: 'NCBI RefSeq',
        datasetId: 'GCF_041296265.1',
        datasetVersion: 'TB-T2T',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_041296265.1/',
        license: 'NCBI public-domain data',
        attribution: 'National Center for Biotechnology Information (NCBI)',
      }),
      contigs: EQU_CAB_TBT2T_PRIMARY_CONTIGS,
    }),
    ...Object.freeze(
      HOSTED_REFERENCE_PREPARED_SOURCE_CATALOGS_V1.map(({ id }) => id)
        .filter((id, index, ids) => ids.indexOf(id) === index)
        .filter(
          (id) =>
            !HOSTED_REFERENCE_HARDCODED_ROLLOUT_IDS_V1.has(id) &&
            id in HOSTED_REFERENCE_PREPARED_BUNDLE_BY_ID_V1
        )
        .map((id) => {
          const definition = HOSTED_REFERENCE_SOURCE_BY_ID_V1.get(id);
          const preparedBundle = HOSTED_REFERENCE_PREPARED_BUNDLE_BY_ID_V1[id];
          if (!definition || !preparedBundle) {
            throw new Error(`Prepared hosted-reference source ${id} is missing.`);
          }
          return Object.freeze({
            ...definition,
            preparedBundle,
          });
        })
    ),
  ]);
