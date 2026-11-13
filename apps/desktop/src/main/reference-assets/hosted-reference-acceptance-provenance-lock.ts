import {
  AGIS1_EXPECTED_ANNOTATION_TRACK_TYPES,
  DM6_EXPECTED_ANNOTATION_TRACK_TYPES,
  EQU_CAB_TB_T2T_EXPECTED_ANNOTATION_TRACK_TYPES,
  GRCZ12TU_EXPECTED_ANNOTATION_TRACK_TYPES,
  M_GOR_GOR1V21_EXPECTED_ANNOTATION_TRACK_TYPES,
  M_ORY_CUN11_EXPECTED_ANNOTATION_TRACK_TYPES,
  M_PAN_TRO3V21_EXPECTED_ANNOTATION_TRACK_TYPES,
  MM39_EXPECTED_ANNOTATION_TRACK_TYPES,
  OAR_RAMBOUILLET_V3_EXPECTED_ANNOTATION_TRACK_TYPES,
  RHE_MAC10_EXPECTED_ANNOTATION_TRACK_TYPES,
  T2T_MMU8V2_EXPECTED_ANNOTATION_TRACK_TYPES,
  XENTRO10_EXPECTED_ANNOTATION_TRACK_TYPES,
  ZMB73V5_EXPECTED_ANNOTATION_TRACK_TYPES,
} from './hosted-reference-acceptance-track-rosters';
import {
  CAN_FAM4_ACCEPTANCE_IDENTITY,
  DAN_RER11_ACCEPTANCE_IDENTITY,
  GRCG7B_ACCEPTANCE_IDENTITY,
  HS1_ACCEPTANCE_IDENTITY,
  POMBE_ASM294V3_ACCEPTANCE_IDENTITY,
  RN7_ACCEPTANCE_IDENTITY,
  RN8_ACCEPTANCE_IDENTITY,
  XEN_LAE10_ACCEPTANCE_IDENTITY,
} from './hosted-reference-acceptance-identities-wave05';
import {
  ARS_UCD2_ACCEPTANCE_IDENTITY,
  CRI_GRI_PICRH1_ACCEPTANCE_IDENTITY,
  GRCZ12AB_ACCEPTANCE_IDENTITY,
  HG19_ACCEPTANCE_IDENTITY,
  MEDAKA_HD_RR31_ACCEPTANCE_IDENTITY,
  MM10_ACCEPTANCE_IDENTITY,
  PAN_TRO6_ACCEPTANCE_IDENTITY,
  SUS_SCR_HXYL_V2_ACCEPTANCE_IDENTITY,
} from './hosted-reference-acceptance-identities-public-data-wave01';
import {
  BOS_TAU9_ACCEPTANCE_IDENTITY,
  CAN_FAM3_ACCEPTANCE_IDENTITY,
  CAN_FAM6_ACCEPTANCE_IDENTITY,
  GAL_GAL6_ACCEPTANCE_IDENTITY,
  POM_BASE_ACCEPTANCE_IDENTITY,
  SUS_SCR11_ACCEPTANCE_IDENTITY,
  TOMATO_SLM_R21_ACCEPTANCE_IDENTITY,
} from './hosted-reference-acceptance-identities-public-data-wave02';
import {
  AGAMBIAE_F1_ACCEPTANCE_IDENTITY,
  ANIDULANS_FGSC_A4_ACCEPTANCE_IDENTITY,
  CANDIDA_SC5314_ACCEPTANCE_IDENTITY,
  IRGSP1_ACCEPTANCE_IDENTITY,
  KPHAFFII_CBS7435_ACCEPTANCE_IDENTITY,
  KPHAFFII_GS115_ACCEPTANCE_IDENTITY,
  NT_K326_ACCEPTANCE_IDENTITY,
  PFALCIPARUM3D7_ACCEPTANCE_IDENTITY,
  SOYBEAN_V4_ACCEPTANCE_IDENTITY,
} from './hosted-reference-acceptance-identities-public-data-wave03';
import {
  SBICOLOR_NCBI_V3_ACCEPTANCE_IDENTITY,
  T2T_MFA8_V11_ACCEPTANCE_IDENTITY,
} from './hosted-reference-acceptance-identities-public-data-extra-demand';
import { WHEAT_REFSEQ_V21_ACCEPTANCE_IDENTITY } from './hosted-reference-acceptance-identities-public-data-wheat';
import { SARS_COV2_WUHAN_HU1_ACCEPTANCE_IDENTITY } from './hosted-reference-acceptance-identities-public-data-sars';
import { NIBEN_KLAB_ACCEPTANCE_IDENTITY } from './hosted-reference-acceptance-identities-public-data-niben';
import {
  BACILLUS168_ACCEPTANCE_IDENTITY,
  CGLUTAMICUM_ATCC13032_ACCEPTANCE_IDENTITY,
  ECOLI_BL21_DE3_ACCEPTANCE_IDENTITY,
  ECOLI_K12_MG1655_ACCEPTANCE_IDENTITY,
  MTB_H37_RV_ACCEPTANCE_IDENTITY,
  PAERUGINOSA_PAO1_ACCEPTANCE_IDENTITY,
  PPUTIDA_KT2440_ACCEPTANCE_IDENTITY,
  SALMONELLA_LT2_ACCEPTANCE_IDENTITY,
  SAUREUS_NCTC8325_ACCEPTANCE_IDENTITY,
  SAUREUS_USA300_FPR3757_ACCEPTANCE_IDENTITY,
  SCOELICOLOR_A32_ACCEPTANCE_IDENTITY,
} from './hosted-reference-acceptance-identities-public-data-bacteria';

export type ProductionHostedReferenceIdV1 =
  | 'grch38'
  | 'sacCer3'
  | 'ce11'
  | 'mm39'
  | 'grcz12tu'
  | 'dm6'
  | 'xenTro10'
  | 'tair10'
  | 'agis1'
  | 'zmB73v5'
  | 't2tMmu8v2'
  | 'rheMac10'
  | 'mPanTro3v21'
  | 'mGorGor1v21'
  | 'mOryCun11'
  | 'oarRambouilletV3'
  | 'equCabTbT2t'
  | 'hs1'
  | 'rn8'
  | 'rn7'
  | 'danRer11'
  | 'pombeAsm294v3'
  | 'xenLae10'
  | 'grcg7b'
  | 'canFam4'
  | 'hg19'
  | 'mm10'
  | 'susScrHxylV2'
  | 'arsUcd2'
  | 'criGriPicrh1'
  | 'panTro6'
  | 'medakaHdRr31'
  | 'grcz12ab'
  | 'canFam3'
  | 'pomBase'
  | 'irgsp1'
  | 'ntK326'
  | 'tomatoSlmR21'
  | 'soybeanV4'
  | 'kphaffiiGs115'
  | 'kphaffiiCbs7435'
  | 'candidaSC5314'
  | 'anidulansFgscA4'
  | 'pfalciparum3d7'
  | 'agambiaeF1'
  | 'galGal6'
  | 'canFam6'
  | 'susScr11'
  | 'bosTau9'
  | 'sarsCov2WuhanHu1'
  | 't2tMfa8v11'
  | 'sbicolorNcbiv3'
  | 'wheatRefseqV21'
  | 'ecoliK12Mg1655'
  | 'ecoliBl21De3'
  | 'bacillus168'
  | 'pputidaKt2440'
  | 'cglutamicumAtcc13032'
  | 'scoelicolorA32'
  | 'mtbH37Rv'
  | 'paeruginosaPao1'
  | 'saureusNctc8325'
  | 'salmonellaLt2'
  | 'saureusUsa300Fpr3757'
  | 'nibenKlab';

export type HostedReferenceAcceptanceFirstViewTransportV1 =
  | Readonly<{
      kind: 'pack';
      relativePath: string;
      sha256: string;
    }>
  | Readonly<{
      kind: 'individual-objects';
    }>;

export interface HostedReferenceAcceptanceIdentityV1 {
  readonly assemblyAccession: string;
  readonly rawFastaRelativePath: string;
  readonly rawFastaSha256: string;
  readonly rawGff3RelativePath: string;
  readonly rawGff3Sha256: string;
  readonly expectedAnnotationTrackTypes: readonly string[] | null;
  readonly preparedManifestRelativePath: string;
  readonly preparedManifestSha256: string;
  readonly firstViewTransport: HostedReferenceAcceptanceFirstViewTransportV1;
  readonly preparedBundleFingerprint: string;
  readonly firstViewRosterSha256: string;
}

export interface HostedReferenceAcceptanceCatalogEntryV1 {
  readonly id: string;
  readonly provenance: Readonly<{
    datasetId: string;
  }>;
  readonly sources: Readonly<{
    fasta: Readonly<{
      relativePath: string;
      sha256: string;
    }>;
    annotations: Readonly<{
      relativePath: string;
      sha256: string;
    }>;
  }>;
  readonly preparedBundle?: Readonly<{
    manifest: Readonly<{
      relativePath: string;
      sha256: string;
    }>;
    firstViewPack?: Readonly<{
      relativePath: string;
      sha256: string;
      bundleManifestSha256: string;
      bundleFingerprint: string;
      rosterSha256: string;
    }>;
  }>;
}

export interface HostedReferenceAcceptanceCandidateV1 {
  readonly assetBaseUrl: string;
  readonly catalog: ReadonlyArray<HostedReferenceAcceptanceCatalogEntryV1>;
}

const SACCER3_EXPECTED_ANNOTATION_TRACK_TYPES = Object.freeze([
  'RNase_MRP_RNA',
  'RNase_P_RNA',
  'SRP_RNA',
  'antisense_RNA',
  'centromere',
  'genomic DNA',
  'long_terminal_repeat',
  'mRNA',
  'ncRNA',
  'origin_of_replication',
  'other',
  'pseudogene',
  'rRNA',
  'retrotransposon:YARCTy1-1',
  'retrotransposon:YBLWTy1-1',
  'retrotransposon:YBLWTy2-1',
  'retrotransposon:YBRWTy1-2',
  'retrotransposon:YCLWTy2-1',
  'retrotransposon:YCLWTy5-1',
  'retrotransposon:YDRCTy1-1',
  'retrotransposon:YDRCTy1-2',
  'retrotransposon:YDRCTy1-3',
  'retrotransposon:YDRCTy2-1',
  'retrotransposon:YDRWTy1-4',
  'retrotransposon:YDRWTy1-5',
  'retrotransposon:YDRWTy2-2',
  'retrotransposon:YDRWTy2-3',
  'retrotransposon:YERCTy1-1',
  'retrotransposon:YERCTy1-2',
  'retrotransposon:YFLWTy2-1',
  'retrotransposon:YGRCTy1-2',
  'retrotransposon:YGRCTy1-3',
  'retrotransposon:YGRCTy2-1',
  'retrotransposon:YGRWTy1-1',
  'retrotransposon:YGRWTy2-2',
  'retrotransposon:YGRWTy3-1',
  'retrotransposon:YHLWTy4-1',
  'retrotransposon:YHRCTy1-1',
  'retrotransposon:YILWTy3-1',
  'retrotransposon:YJLWTy4-1',
  'retrotransposon:YJRWTy1-1',
  'retrotransposon:YJRWTy1-2',
  'retrotransposon:YLRCTy1-1',
  'retrotransposon:YLRCTy2-2',
  'retrotransposon:YLRWTy1-2',
  'retrotransposon:YLRWTy1-3',
  'retrotransposon:YLRWTy2-1',
  'retrotransposon:YMLWTy1-1',
  'retrotransposon:YMLWTy1-2',
  'retrotransposon:YMRCTy1-3',
  'retrotransposon:YMRCTy1-4',
  'retrotransposon:YNLCTy1-1',
  'retrotransposon:YNLCTy2-1',
  'retrotransposon:YNLWTy1-2',
  'retrotransposon:YOLWTy1-1',
  'retrotransposon:YORCTy2-1',
  'retrotransposon:YORWTy1-2',
  'retrotransposon:YORWTy2-2',
  'retrotransposon:YPLCTy4-1',
  'retrotransposon:YPLWTy1-1',
  'retrotransposon:YPRCTy1-2',
  'retrotransposon:YPRCTy1-4',
  'retrotransposon:YPRWTy1-3',
  'sequence_feature',
  'snRNA',
  'snoRNA',
  'tRNA',
  'telomerase_RNA',
  'telomere',
  'transcript',
]);

const CE11_EXPECTED_ANNOTATION_TRACK_TYPES = Object.freeze([
  'antisense_RNA',
  'genomic DNA',
  'lncRNA',
  'mRNA',
  'miRNA',
  'ncRNA',
  'piRNA',
  'primary_transcript',
  'pseudogene',
  'pseudogenic_rRNA',
  'pseudogenic_tRNA',
  'rRNA',
  'scRNA',
  'sequence_feature',
  'snRNA',
  'snoRNA',
  'tRNA',
  'transcript',
]);

const TAIR10_EXPECTED_ANNOTATION_TRACK_TYPES = Object.freeze([
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

const GRCH38_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000001405.40',
  rawFastaRelativePath:
    'grch38/GCF_000001405.40/c798efbf2cb51c6d/GRCh38.p14.primary-assembly.fa.gz',
  rawFastaSha256: 'c798efbf2cb51c6d01b6a759e6c3cf5b48d3b58b95f7ea2fcd0f3e03cde5ae61',
  rawGff3RelativePath:
    'grch38/GCF_000001405.40/6f6da659257e9573/GRCh38.p14.primary-assembly.gff3.gz',
  rawGff3Sha256: '6f6da659257e957387360de699ee3f45206ada3edd5fc233399773fc98db7d16',
  expectedAnnotationTrackTypes: null,
  preparedManifestRelativePath:
    'objects/sha256/67/67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
  preparedManifestSha256: '67f652f20e326553d2207016cff36ad4a4bba35ee7f214b7c65914ae82bc1783',
  firstViewTransport: Object.freeze({ kind: 'individual-objects' }),
  preparedBundleFingerprint: '2631f0a843e0f74191ef0b53c4e4c6757c5a0439bd41f257ac6d95c0d4d8ea26',
  firstViewRosterSha256: 'd18a8fd874e193563d14afdee54154dd431a175d4b7e378babd55fbed46d652e',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const SACCER3_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000146045.2',
  rawFastaRelativePath: 'sacCer3/GCF_000146045.2/fe42735d3e6242f/GCF_000146045.2_R64_genomic.fna',
  rawFastaSha256: 'fe42735d3e6242f8c40b457a232940e34ef15eb4502717e54a34ed118face4c1',
  rawGff3RelativePath: 'sacCer3/GCF_000146045.2/228ea6918fc034e8/genomic.gff',
  rawGff3Sha256: '228ea6918fc034e80a34f87d30729c0a8caeb019861baef7d14878324a0d7b8c',
  expectedAnnotationTrackTypes: SACCER3_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/5f/5f0670dc842c9ea3eabb5836e8d85f8e31a70e8cb83bf31c217ccc7b9cb82686',
  preparedManifestSha256: '5f0670dc842c9ea3eabb5836e8d85f8e31a70e8cb83bf31c217ccc7b9cb82686',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/5a/5a0acf68f7fba84fbd0e84c12825469b22ddc711020befc7edfa4d8b97798efe',
    sha256: '5a0acf68f7fba84fbd0e84c12825469b22ddc711020befc7edfa4d8b97798efe',
  }),
  preparedBundleFingerprint: '42c7550275b5f626188a030dd26ed65506ad926d52d6e0e1713875ba25a18a5f',
  firstViewRosterSha256: '7cbcf8e15bc6d224ad217b0e976195824f7ed7d034292dca45c2b4547debe9d3',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const CE11_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000002985.6',
  rawFastaRelativePath:
    'ce11/GCF_000002985.6/739d1fb774ef9f5a/GCF_000002985.6_WBcel235_genomic.fna',
  rawFastaSha256: '739d1fb774ef9f5a2de12fd16de3e559201d00d69502b7013d820584d9369220',
  rawGff3RelativePath: 'ce11/GCF_000002985.6/b6296b398ce09b94/genomic.gff',
  rawGff3Sha256: 'b6296b398ce09b944696d7519d5013886e3ee2172760a6a6849774afc116334d',
  expectedAnnotationTrackTypes: CE11_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/2e/2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
  preparedManifestSha256: '2e0279435ecb3b17434899460d8d107ad8d34dc1db878de74609b0b7e018257c',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/a1/a174a80a10f489d8bb81f785bb122f1e30b1f151abed7c0783ad75baf2173de6',
    sha256: 'a174a80a10f489d8bb81f785bb122f1e30b1f151abed7c0783ad75baf2173de6',
  }),
  preparedBundleFingerprint: 'e2a1dd3164b02f6d9bbbdb739ca10bea03c00e772e817e2832b6a90b095d679a',
  firstViewRosterSha256: '74d5572a4b25d304e78b79d799f886c80464535edc10c8d04b6fa090705dac30',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const TAIR10_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000001735.4',
  rawFastaRelativePath:
    'tair10/GCF_000001735.4/af518a561a710416/GCF_000001735.4_TAIR10.1_primary.fna.gz',
  rawFastaSha256: 'af518a561a710416597b362610656aea4b5c53d1bedf73c420bef1ffaf10f73b',
  rawGff3RelativePath:
    'tair10/GCF_000001735.4/13eb73d29cce948b/GCF_000001735.4_TAIR10.1_primary.gff3.gz',
  rawGff3Sha256: '13eb73d29cce948b7f9a80aaa18173914c07d5bfae015e6e86b7f1ccbdad8e80',
  expectedAnnotationTrackTypes: TAIR10_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/1b/1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
  preparedManifestSha256: '1b210e17ba8de7fab73fd1f5ad4e35ac961935ebc7fce6ccf7ac710397f6f316',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/17/17faeaa3aee7cd8edc3471af1043a8c52ec15244ffe6d0c184d83a70859dea14',
    sha256: '17faeaa3aee7cd8edc3471af1043a8c52ec15244ffe6d0c184d83a70859dea14',
  }),
  preparedBundleFingerprint: '3168cf06126e4922c346c2e371ba7006111b6d369c4d1c2a35a8388a90814c10',
  firstViewRosterSha256: 'ce17772d442d480a63c34235ad3c2095cfaa65d6992065299c7e78df8b2098f5',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const MM39_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000001635.27',
  rawFastaRelativePath:
    'mm39/GCF_000001635.27/3185b185d83de72a/GCF_000001635.27_GRCm39_primary.fna.gz',
  rawFastaSha256: '3185b185d83de72aacab15b247ed5734982b657fc0be8b26fc3c14fed578f1fa',
  rawGff3RelativePath:
    'mm39/GCF_000001635.27/0f0a0e4aa69a22dc/GCF_000001635.27_GRCm39_primary.gff3.gz',
  rawGff3Sha256: '0f0a0e4aa69a22dc4bae0d4d1b5d224c0a439c3fcc705869fae76ad681230a35',
  expectedAnnotationTrackTypes: MM39_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/fa/fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
  preparedManifestSha256: 'fa7814ad8158d3e6ff3bf64c5607fafd83ccd3794d58f4303187c079fbc9cc35',
  firstViewTransport: Object.freeze({ kind: 'individual-objects' }),
  preparedBundleFingerprint: 'dfa1293c4d9b1a76143ff7985304ad8d523f8b8dcf75ae4e549b7b628115b3c0',
  firstViewRosterSha256: 'f5f444e2f51f4a4d7d7f486f102c61374d056aae347c817fc6ddbed0abca6750',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const GRCZ12TU_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_049306965.2', // gitleaks:allow
  rawFastaRelativePath:
    'grcz12tu/GCF_049306965.2/c684d7b71548a141/GCF_049306965.2_GRCz12tu_primary.fna.gz',
  rawFastaSha256: 'c684d7b71548a141551710c3f2edfa77f7591028a6ad2297d9e3a43b708c8982',
  rawGff3RelativePath:
    'grcz12tu/GCF_049306965.2/3515f63aab87a5ad/GCF_049306965.2_GRCz12tu_primary.gff3.gz',
  rawGff3Sha256: '3515f63aab87a5ad5b8ff6b138d2d9357d4431551501e1a5dbf29252a52e48a3',
  expectedAnnotationTrackTypes: GRCZ12TU_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/fb/fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
  preparedManifestSha256: 'fb7d1050788f853c7b68399898ca27cd5c61abbfc417cc23fc5cec5ffb14d5e7',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/bc/bcdfda150189852b3754232d7ba4deb4e01e3181dae11e372dbe2b1eb24ed0a6',
    sha256: 'bcdfda150189852b3754232d7ba4deb4e01e3181dae11e372dbe2b1eb24ed0a6',
  }),
  preparedBundleFingerprint: 'a3f01efaca7d340c56448283cc56d8ece3bdfc046895b9a88f3c42e6b5fa75ca',
  firstViewRosterSha256: '909a5a4902ff74bbfc4273058d65692369d91aaad77469065e4c20afcca3c0a0',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const DM6_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000001215.4',
  rawFastaRelativePath: 'dm6/GCF_000001215.4/e02cee38083b5fec/GCF_000001215.4_dm6_primary.fna.gz',
  rawFastaSha256: 'e02cee38083b5fecf0819185f1ed236d94f6f08896db5968bddc4d7a6351e990',
  rawGff3RelativePath: 'dm6/GCF_000001215.4/ae77e6aefd60c0e5/GCF_000001215.4_dm6_primary.gff3.gz',
  rawGff3Sha256: 'ae77e6aefd60c0e513ed77a882b587d57dc17b43d98b78a1b21a3da3f4d636dd',
  expectedAnnotationTrackTypes: DM6_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/e6/e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
  preparedManifestSha256: 'e6d177aa0568b0a827ee8de2bcde6ae198e5c107346e3c010557838eb6827cfe',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/8a/8abdbd3ab929b2b5439ab13ca3fc4a7f650b96cd2defcf6da3398a7cad66854a',
    sha256: '8abdbd3ab929b2b5439ab13ca3fc4a7f650b96cd2defcf6da3398a7cad66854a',
  }),
  preparedBundleFingerprint: '46108d88fb2549650445d709a5849e96c66f7e4fb348ae95615ea22a43cf301e',
  firstViewRosterSha256: 'bf7dfcd7c09e4aa0e0091bff091549ba64f77034e2a51b78951ecbe46e41ad11',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const XENTRO10_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000004195.4',
  rawFastaRelativePath:
    'xenTro10/GCF_000004195.4/caeeff933dd13808/GCF_000004195.4_UCB_Xtro_10.0_primary.fna.gz',
  rawFastaSha256: 'caeeff933dd138086456e9b5d774729ad9e26794b49a3527ac522fbde5f2f7cf',
  rawGff3RelativePath:
    'xenTro10/GCF_000004195.4/eedbc5ab1f7a4bc9/GCF_000004195.4_UCB_Xtro_10.0_primary.gff3.gz',
  rawGff3Sha256: 'eedbc5ab1f7a4bc980d86c0e2523a5ed29fb92005b453e1138c5eb589f8b61d0',
  expectedAnnotationTrackTypes: XENTRO10_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/9c/9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
  preparedManifestSha256: '9c106e46fa691ac9ff38b1097b7a17580eed048d079abda940f0c031f1824891',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/f2/f2966f716381255b9c967f0a3889f108fe80542731cbceb9b216e00de3665035',
    sha256: 'f2966f716381255b9c967f0a3889f108fe80542731cbceb9b216e00de3665035',
  }),
  preparedBundleFingerprint: 'de7582ee2aa4d793fdf245305bae8723f9158cbf5b1fdfaec2b8a8e60a06f8c2',
  firstViewRosterSha256: '99f61e79171195de3ebffafad4b1d34820ea949f038a2dd1a53ec500a6ba96dc',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const AGIS1_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_034140825.1', // gitleaks:allow
  rawFastaRelativePath:
    'agis1/GCF_034140825.1/3c2bb9240ef89731/GCF_034140825.1_AGIS1.0_primary.fna.gz',
  rawFastaSha256: '3c2bb9240ef8973144e945872b31af591dfa55c4587b128b41bea1bb3795465b',
  rawGff3RelativePath:
    'agis1/GCF_034140825.1/b1837ac52c65292f/GCF_034140825.1_AGIS1.0_primary.gff3.gz',
  rawGff3Sha256: 'b1837ac52c65292fa1c28c64ace8c05a81c54e535cf54c7fa4186a1f4695992b',
  expectedAnnotationTrackTypes: AGIS1_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/fa/fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
  preparedManifestSha256: 'fa8ffcc8ea13ace7bda2f0ad10f3b80345c0df5931af77f81502cb0fd99e709b',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/42/42149e89e23d6682575963d8e14511e82762d97a1b5e86742b515e67ef211952',
    sha256: '42149e89e23d6682575963d8e14511e82762d97a1b5e86742b515e67ef211952',
  }),
  preparedBundleFingerprint: '1f823c0c190bd38158c11802e1396860721e9891086c48c9da93846c13bdc375',
  firstViewRosterSha256: '7ec0c2fbf13f12340f026630e7477fb6a4cb98f9afd3a076f2ce4ecb9136bd04',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const ZMB73V5_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_902167145.1', // gitleaks:allow
  rawFastaRelativePath:
    'zmB73v5/GCF_902167145.1/4627fdd2b5afb5f5/GCF_902167145.1_NAM_5.0_primary.fna.gz',
  rawFastaSha256: '4627fdd2b5afb5f5ee5659c2f43e983ce309e65457a9fb6ae2265e902b05dc0f',
  rawGff3RelativePath:
    'zmB73v5/GCF_902167145.1/40052a527b5b8bbf/GCF_902167145.1_NAM_5.0_primary.gff3.gz',
  rawGff3Sha256: '40052a527b5b8bbf7460a7c937521a6bdd7450b7174605b3a76731bcf2dd6d45',
  expectedAnnotationTrackTypes: ZMB73V5_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/e3/e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
  preparedManifestSha256: 'e300a9aa861fe70298867364640f73507f60cfb2e53ddd3f9169b9a898c7b1a2',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/90/906ef45b2ea55b80aed3d715f4cce8f4ded1e515dbc709d98f73ac51db0421df',
    sha256: '906ef45b2ea55b80aed3d715f4cce8f4ded1e515dbc709d98f73ac51db0421df',
  }),
  preparedBundleFingerprint: '8819e93e4c36764e9a75c9c4d475ade118b67244c7f23d47216feab50dd00aa4',
  firstViewRosterSha256: '8c258b0d773d151b5ba1a856b6709440a8910a320ff922b2eb81a78856b417bf',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const T2T_MMU8V2_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_049350105.2', // gitleaks:allow
  rawFastaRelativePath: 't2tMmu8v2/GCF_049350105.2/cb667b37d58cd5b7/GCF_049350105.2_primary.fna',
  rawFastaSha256: 'cb667b37d58cd5b7146c6ee081683c1c56bc9c39cdb712782a24a873f27fb7a3',
  rawGff3RelativePath: 't2tMmu8v2/GCF_049350105.2/ec5be862bba7e4d0/GCF_049350105.2_primary.gff3',
  rawGff3Sha256: 'ec5be862bba7e4d0749e2e57aa9d128551d8fbbc850587ce112ab565d78feb11',
  expectedAnnotationTrackTypes: T2T_MMU8V2_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/a5/a57b738e09342bcc2edc0dbf77ea60a5a4a997574dc96d41c8fcdf60d899c37e',
  preparedManifestSha256: 'a57b738e09342bcc2edc0dbf77ea60a5a4a997574dc96d41c8fcdf60d899c37e',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/b9/b9f9be6c0b93ffc0552c3bc8e275281053f448319d82884ad46c284442e1006b',
    sha256: 'b9f9be6c0b93ffc0552c3bc8e275281053f448319d82884ad46c284442e1006b',
  }),
  preparedBundleFingerprint: '0a547d91b6c47ca43257bf9031f4965e6fb572eb2bcb9c12e047bace8fac3f2a',
  firstViewRosterSha256: 'd5ec1b6e11e0292a7ec680ec988b980648ea5ee867214c94999b69264fd3333c',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const RHE_MAC10_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_003339765.1',
  rawFastaRelativePath: 'rheMac10/GCF_003339765.1/ee3f2e50f2e5e97e/GCF_003339765.1_primary.fna',
  rawFastaSha256: 'ee3f2e50f2e5e97e06bb5b5b4268c47756d2750ee825d3ac91c11de9af2f9036',
  rawGff3RelativePath: 'rheMac10/GCF_003339765.1/48a4f1723e005378/GCF_003339765.1_primary.gff3',
  rawGff3Sha256: '48a4f1723e0053780fe69ffc6cfa8cc2f9e53da5b2f2dba2c007792e83f18cd7',
  expectedAnnotationTrackTypes: RHE_MAC10_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/29/2936aec7fa038f02ef23901ecacf0c2ad1262a796f0e498a17fc8e45cb837c05',
  preparedManifestSha256: '2936aec7fa038f02ef23901ecacf0c2ad1262a796f0e498a17fc8e45cb837c05',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/3f/3f76ccb896f68ce5c9683edeb56a9aa29ceae0e5feaabdf512f5f6e793ac6d2e',
    sha256: '3f76ccb896f68ce5c9683edeb56a9aa29ceae0e5feaabdf512f5f6e793ac6d2e',
  }),
  preparedBundleFingerprint: '6f523874b9b3326dda82a7d3507ebcff79a15058712bc67b1a3989179d71da14',
  firstViewRosterSha256: 'ac8830a41c53c63a42e8e80d289ebcceeccb1a7ff12a9fd48387318813dbfe0f',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const M_PAN_TRO3V21_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_028858775.2',
  rawFastaRelativePath: 'mPanTro3v21/GCF_028858775.2/01376b85cfbe6c4f/GCF_028858775.2_primary.fna',
  rawFastaSha256: '01376b85cfbe6c4f569078095a61a793ceacb928a4d6b797e4c53c7c117a0f6e',
  rawGff3RelativePath: 'mPanTro3v21/GCF_028858775.2/aaba8ba29d2081a8/GCF_028858775.2_primary.gff3',
  rawGff3Sha256: 'aaba8ba29d2081a8ccdc170d1196e0c33023fd4072456e3c1a530c318d8d5c89',
  expectedAnnotationTrackTypes: M_PAN_TRO3V21_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/98/98f85a1994fc0470ea337fc1533a640f06223b5f40b401070f05585ecadd390f',
  preparedManifestSha256: '98f85a1994fc0470ea337fc1533a640f06223b5f40b401070f05585ecadd390f',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/cf/cf169e0f58de35d9dbfdef7b86472c2dd200dcc505514f7e38dbd02fcde5bbce',
    sha256: 'cf169e0f58de35d9dbfdef7b86472c2dd200dcc505514f7e38dbd02fcde5bbce',
  }),
  preparedBundleFingerprint: 'ffdb820f5bf2b78190c0dade164cf397d9a45dd8e129b4d95c32a0529e9e7640',
  firstViewRosterSha256: 'b91c73bbd26aebf822b03006f94d61dd7a693e92443e51191a7e3c86f2c924dd',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const M_GOR_GOR1V21_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_029281585.2',
  rawFastaRelativePath: 'mGorGor1v21/GCF_029281585.2/b828375c433f77c0/GCF_029281585.2_primary.fna',
  rawFastaSha256: 'b828375c433f77c0292361c73f3dd31e98e5cd804663b3c162245a6325213508',
  rawGff3RelativePath: 'mGorGor1v21/GCF_029281585.2/93332a5c08ea6635/GCF_029281585.2_primary.gff3',
  rawGff3Sha256: '93332a5c08ea6635a87e8f4617ea5c280fdef86192b9ea9fe3b938183f620eac',
  expectedAnnotationTrackTypes: M_GOR_GOR1V21_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/f5/f5bc9cf4131d23a58633823092aada2c31690246d0786b23d9c950a93c9f2162',
  preparedManifestSha256: 'f5bc9cf4131d23a58633823092aada2c31690246d0786b23d9c950a93c9f2162',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/80/809ddea82cfc207a85defb4e24c1dd70600c78b775a6012fa1afa2af47d08af9',
    sha256: '809ddea82cfc207a85defb4e24c1dd70600c78b775a6012fa1afa2af47d08af9',
  }),
  preparedBundleFingerprint: '28c54a0a4e19974e6a8f1a5cd17db00c0e0998df7e92a3d93331ec8dd1c5ebe2',
  firstViewRosterSha256: '3edce338c46a0b17e661ba66c4822d5ab206503df6a7ae6727edd0c7e658fff9',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const M_ORY_CUN11_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_964237555.1', // gitleaks:allow
  rawFastaRelativePath: 'mOryCun11/GCF_964237555.1/f24f1b8720007327/GCF_964237555.1_primary.fna',
  rawFastaSha256: 'f24f1b87200073273531c26c0fd6d201697b8cf343419b6d4893f94f5762f0e2',
  rawGff3RelativePath: 'mOryCun11/GCF_964237555.1/dc8580a3222cfde3/GCF_964237555.1_primary.gff3',
  rawGff3Sha256: 'dc8580a3222cfde39e4fe4e73ad7e2f008c1567b9e6f28b41bcd178fc34c40e5',
  expectedAnnotationTrackTypes: M_ORY_CUN11_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/c4/c4700388288a4b423d470a049a3ccfb74bda500849a8d4d3cfd04a0c7f6d25d9',
  preparedManifestSha256: 'c4700388288a4b423d470a049a3ccfb74bda500849a8d4d3cfd04a0c7f6d25d9',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/90/90715a9eef7ea7b4b4f0f34eec05be1965b3b91733943079e91b90d8abdf126f',
    sha256: '90715a9eef7ea7b4b4f0f34eec05be1965b3b91733943079e91b90d8abdf126f',
  }),
  preparedBundleFingerprint: '8347cc4d19c547c8907d1a9859879554dd67ef7dd3c07879f7e1f86644b52adb',
  firstViewRosterSha256: 'b867bad95474ed3ae36ae3065f9f79dccc0167c683d50d6816c58206e87461fd',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const OAR_RAMBOUILLET_V3_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_016772045.2', // gitleaks:allow
  rawFastaRelativePath:
    'oarRambouilletV3/GCF_016772045.2/4676028b1a68b41e/GCF_016772045.2_primary.fna',
  rawFastaSha256: '4676028b1a68b41e56dd6e525560805d3db320f54f783a94ee8898db30242f3e',
  rawGff3RelativePath:
    'oarRambouilletV3/GCF_016772045.2/456ff3f9116d3551/GCF_016772045.2_primary.gff3',
  rawGff3Sha256: '456ff3f9116d3551796cb68a1af4cf77d7061735b93f01fbef4d62e41b2edda4',
  expectedAnnotationTrackTypes: OAR_RAMBOUILLET_V3_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/18/1877a6c53ccc704352447708efbd4803299acf2f46502c6385597a294f7609a7',
  preparedManifestSha256: '1877a6c53ccc704352447708efbd4803299acf2f46502c6385597a294f7609a7',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/66/66105f9da835c3c88c2060d881c00438ed8bb857bc7b80a761c1efc00f445720',
    sha256: '66105f9da835c3c88c2060d881c00438ed8bb857bc7b80a761c1efc00f445720',
  }),
  preparedBundleFingerprint: '86e123c18d84af566846b1731eff1bf841679238d2d6ab108bd1eb54a9379b46',
  firstViewRosterSha256: '490b39244cddf4604608859b256270a2f9419661e199c2f28fab399f91249226',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const EQU_CAB_TB_T2T_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_041296265.1', // gitleaks:allow
  rawFastaRelativePath: 'equCabTbT2t/GCF_041296265.1/24482aea51b7584e/GCF_041296265.1_primary.fna',
  rawFastaSha256: '24482aea51b7584e00c25511d459fd070cb66a43ce14428a0a69405a6526d941',
  rawGff3RelativePath: 'equCabTbT2t/GCF_041296265.1/db3240f486c8379e/GCF_041296265.1_primary.gff3',
  rawGff3Sha256: 'db3240f486c8379e85dbdcb20c5871edccf51d84b4f5bb6bb68b3031a2ef0a92',
  expectedAnnotationTrackTypes: EQU_CAB_TB_T2T_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/3c/3c5f1b8d05fc0b14aeb7172e28c294b6db82e1cf66a826ef3b5a5afe33beb5e0',
  preparedManifestSha256: '3c5f1b8d05fc0b14aeb7172e28c294b6db82e1cf66a826ef3b5a5afe33beb5e0',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/9f/9f3db722a3dd9a672ef71e54bd72e1f357b3f0a76a9593b6731dba02900be9c7',
    sha256: '9f3db722a3dd9a672ef71e54bd72e1f357b3f0a76a9593b6731dba02900be9c7',
  }),
  preparedBundleFingerprint: 'f417da9ef3eaebb6bd9e0ef03f3b322f38c2fc0f405edf5dd52936e139e2534f',
  firstViewRosterSha256: '72fd4f5d9fa90f3a747abd3d21d16afea2adb996a702620b213a4cba7b786791',
}) satisfies HostedReferenceAcceptanceIdentityV1;

const LOCKED_IDENTITIES = Object.freeze({
  grch38: GRCH38_IDENTITY,
  sacCer3: SACCER3_IDENTITY,
  ce11: CE11_IDENTITY,
  mm39: MM39_IDENTITY,
  grcz12tu: GRCZ12TU_IDENTITY,
  dm6: DM6_IDENTITY,
  xenTro10: XENTRO10_IDENTITY,
  tair10: TAIR10_IDENTITY,
  agis1: AGIS1_IDENTITY,
  zmB73v5: ZMB73V5_IDENTITY,
  t2tMmu8v2: T2T_MMU8V2_IDENTITY,
  rheMac10: RHE_MAC10_IDENTITY,
  mPanTro3v21: M_PAN_TRO3V21_IDENTITY,
  mGorGor1v21: M_GOR_GOR1V21_IDENTITY,
  mOryCun11: M_ORY_CUN11_IDENTITY,
  oarRambouilletV3: OAR_RAMBOUILLET_V3_IDENTITY,
  equCabTbT2t: EQU_CAB_TB_T2T_IDENTITY,
  hs1: HS1_ACCEPTANCE_IDENTITY,
  hg19: HG19_ACCEPTANCE_IDENTITY,
  mm10: MM10_ACCEPTANCE_IDENTITY,
  rn8: RN8_ACCEPTANCE_IDENTITY,
  rn7: RN7_ACCEPTANCE_IDENTITY,
  danRer11: DAN_RER11_ACCEPTANCE_IDENTITY,
  pombeAsm294v3: POMBE_ASM294V3_ACCEPTANCE_IDENTITY,
  xenLae10: XEN_LAE10_ACCEPTANCE_IDENTITY,
  grcg7b: GRCG7B_ACCEPTANCE_IDENTITY,
  canFam4: CAN_FAM4_ACCEPTANCE_IDENTITY,
  susScrHxylV2: SUS_SCR_HXYL_V2_ACCEPTANCE_IDENTITY,
  arsUcd2: ARS_UCD2_ACCEPTANCE_IDENTITY,
  criGriPicrh1: CRI_GRI_PICRH1_ACCEPTANCE_IDENTITY,
  panTro6: PAN_TRO6_ACCEPTANCE_IDENTITY,
  grcz12ab: GRCZ12AB_ACCEPTANCE_IDENTITY,
  canFam3: CAN_FAM3_ACCEPTANCE_IDENTITY,
  pomBase: POM_BASE_ACCEPTANCE_IDENTITY,
  irgsp1: IRGSP1_ACCEPTANCE_IDENTITY,
  ntK326: NT_K326_ACCEPTANCE_IDENTITY,
  tomatoSlmR21: TOMATO_SLM_R21_ACCEPTANCE_IDENTITY,
  soybeanV4: SOYBEAN_V4_ACCEPTANCE_IDENTITY,
  kphaffiiGs115: KPHAFFII_GS115_ACCEPTANCE_IDENTITY,
  kphaffiiCbs7435: KPHAFFII_CBS7435_ACCEPTANCE_IDENTITY,
  candidaSC5314: CANDIDA_SC5314_ACCEPTANCE_IDENTITY,
  anidulansFgscA4: ANIDULANS_FGSC_A4_ACCEPTANCE_IDENTITY,
  pfalciparum3d7: PFALCIPARUM3D7_ACCEPTANCE_IDENTITY,
  agambiaeF1: AGAMBIAE_F1_ACCEPTANCE_IDENTITY,
  medakaHdRr31: MEDAKA_HD_RR31_ACCEPTANCE_IDENTITY,
  galGal6: GAL_GAL6_ACCEPTANCE_IDENTITY,
  canFam6: CAN_FAM6_ACCEPTANCE_IDENTITY,
  susScr11: SUS_SCR11_ACCEPTANCE_IDENTITY,
  bosTau9: BOS_TAU9_ACCEPTANCE_IDENTITY,
  sarsCov2WuhanHu1: SARS_COV2_WUHAN_HU1_ACCEPTANCE_IDENTITY,
  t2tMfa8v11: T2T_MFA8_V11_ACCEPTANCE_IDENTITY,
  sbicolorNcbiv3: SBICOLOR_NCBI_V3_ACCEPTANCE_IDENTITY,
  wheatRefseqV21: WHEAT_REFSEQ_V21_ACCEPTANCE_IDENTITY,
  ecoliK12Mg1655: ECOLI_K12_MG1655_ACCEPTANCE_IDENTITY,
  ecoliBl21De3: ECOLI_BL21_DE3_ACCEPTANCE_IDENTITY,
  bacillus168: BACILLUS168_ACCEPTANCE_IDENTITY,
  pputidaKt2440: PPUTIDA_KT2440_ACCEPTANCE_IDENTITY,
  cglutamicumAtcc13032: CGLUTAMICUM_ATCC13032_ACCEPTANCE_IDENTITY,
  scoelicolorA32: SCOELICOLOR_A32_ACCEPTANCE_IDENTITY,
  mtbH37Rv: MTB_H37_RV_ACCEPTANCE_IDENTITY,
  paeruginosaPao1: PAERUGINOSA_PAO1_ACCEPTANCE_IDENTITY,
  saureusNctc8325: SAUREUS_NCTC8325_ACCEPTANCE_IDENTITY,
  salmonellaLt2: SALMONELLA_LT2_ACCEPTANCE_IDENTITY,
  saureusUsa300Fpr3757: SAUREUS_USA300_FPR3757_ACCEPTANCE_IDENTITY,
  nibenKlab: NIBEN_KLAB_ACCEPTANCE_IDENTITY,
}) satisfies Readonly<Record<ProductionHostedReferenceIdV1, HostedReferenceAcceptanceIdentityV1>>;

export const HOSTED_REFERENCE_ACCEPTANCE_PROVENANCE_LOCK_V1 = Object.freeze({
  contract: 'dnaforge-hosted-reference-acceptance-provenance-lock.v1' as const,
  canonicalAssetBaseUrl: 'https://references.dnaforge.com/reference-genomes/v1/',
  references: LOCKED_IDENTITIES,
});

function displayActual(value: string | undefined): string {
  return value === undefined ? '<missing>' : value;
}

function recordMismatch(
  failures: string[],
  id: string,
  field: string,
  actual: string | undefined,
  expected: string
): void {
  if (actual === expected) return;
  failures.push(`${id}.${field} expected=${expected} actual=${displayActual(actual)}`);
}

type HostedReferenceAcceptanceFirstViewPackCandidateV1 = NonNullable<
  NonNullable<HostedReferenceAcceptanceCatalogEntryV1['preparedBundle']>['firstViewPack']
>;

export function hostedReferenceAcceptanceFirstViewTransportFailures(
  id: string,
  expected: HostedReferenceAcceptanceIdentityV1,
  pack: HostedReferenceAcceptanceFirstViewPackCandidateV1 | undefined
): ReadonlyArray<string> {
  const failures: string[] = [];
  switch (expected.firstViewTransport.kind) {
    case 'pack':
      if (!pack) {
        failures.push(`${id}.firstViewTransport expected=pack actual=individual-objects`);
      }
      recordMismatch(
        failures,
        id,
        'firstViewTransport.relativePath',
        pack?.relativePath,
        expected.firstViewTransport.relativePath
      );
      recordMismatch(
        failures,
        id,
        'firstViewTransport.sha256',
        pack?.sha256,
        expected.firstViewTransport.sha256
      );
      recordMismatch(
        failures,
        id,
        'firstViewPack.bundleManifestSha256',
        pack?.bundleManifestSha256,
        expected.preparedManifestSha256
      );
      recordMismatch(
        failures,
        id,
        'preparedBundleFingerprint',
        pack?.bundleFingerprint,
        expected.preparedBundleFingerprint
      );
      recordMismatch(
        failures,
        id,
        'firstViewRosterSha256',
        pack?.rosterSha256,
        expected.firstViewRosterSha256
      );
      break;
    case 'individual-objects':
      if (pack) {
        failures.push(`${id}.firstViewTransport expected=individual-objects actual=pack`);
      }
      break;
  }
  return Object.freeze(failures);
}

export function hostedReferenceAcceptanceFirstViewTransportMilestone(
  transport: HostedReferenceAcceptanceFirstViewTransportV1
): 'canonical-first-view-pack' | 'canonical-individual-objects' {
  switch (transport.kind) {
    case 'pack':
      return 'canonical-first-view-pack';
    case 'individual-objects':
      return 'canonical-individual-objects';
  }
}

export function hostedReferenceAcceptanceProvenanceFailures(
  candidate: HostedReferenceAcceptanceCandidateV1
): ReadonlyArray<string> {
  const failures: string[] = [];
  const lock = HOSTED_REFERENCE_ACCEPTANCE_PROVENANCE_LOCK_V1;

  if (candidate.assetBaseUrl !== lock.canonicalAssetBaseUrl) {
    failures.push(
      `assetBaseUrl expected=${lock.canonicalAssetBaseUrl} actual=${displayActual(candidate.assetBaseUrl)}`
    );
  }

  const expectedIds = Object.keys(lock.references) as ProductionHostedReferenceIdV1[];
  const actualIds = candidate.catalog.map(({ id }) => id);
  const actualIdSet = new Set(actualIds);
  const missingIds = expectedIds.filter((id) => !actualIdSet.has(id));
  const unexpectedIds = [...actualIdSet].filter(
    (id): id is string => !expectedIds.includes(id as ProductionHostedReferenceIdV1)
  );

  if (missingIds.length > 0) {
    failures.push(`production hosted IDs missing: ${missingIds.join(', ')}`);
  }
  if (unexpectedIds.length > 0) {
    failures.push(`production hosted IDs unexpected: ${unexpectedIds.join(', ')}`);
  }

  for (const id of expectedIds) {
    const matchingEntries = candidate.catalog.filter((entry) => entry.id === id);
    if (matchingEntries.length > 1) {
      failures.push(`production hosted ID duplicated: ${id} (${matchingEntries.length} entries)`);
    }
    if (matchingEntries.length !== 1) continue;

    const entry = matchingEntries[0];
    const expected = lock.references[id];
    const manifest = entry.preparedBundle?.manifest;
    const pack = entry.preparedBundle?.firstViewPack;

    recordMismatch(
      failures,
      id,
      'assemblyAccession',
      entry.provenance.datasetId,
      expected.assemblyAccession
    );
    recordMismatch(
      failures,
      id,
      'rawFastaRelativePath',
      entry.sources.fasta.relativePath,
      expected.rawFastaRelativePath
    );
    recordMismatch(
      failures,
      id,
      'rawFastaSha256',
      entry.sources.fasta.sha256,
      expected.rawFastaSha256
    );
    recordMismatch(
      failures,
      id,
      'rawGff3RelativePath',
      entry.sources.annotations.relativePath,
      expected.rawGff3RelativePath
    );
    recordMismatch(
      failures,
      id,
      'rawGff3Sha256',
      entry.sources.annotations.sha256,
      expected.rawGff3Sha256
    );
    recordMismatch(
      failures,
      id,
      'preparedManifestRelativePath',
      manifest?.relativePath,
      expected.preparedManifestRelativePath
    );
    recordMismatch(
      failures,
      id,
      'preparedManifestSha256',
      manifest?.sha256,
      expected.preparedManifestSha256
    );
    failures.push(...hostedReferenceAcceptanceFirstViewTransportFailures(id, expected, pack));
  }

  return Object.freeze(failures);
}

export function assertHostedReferenceAcceptanceProvenance(
  candidate: HostedReferenceAcceptanceCandidateV1
): void {
  const failures = hostedReferenceAcceptanceProvenanceFailures(candidate);
  if (failures.length === 0) return;
  throw new Error(
    `Hosted-reference acceptance provenance lock rejected the candidate:\n- ${failures.join('\n- ')}`
  );
}
