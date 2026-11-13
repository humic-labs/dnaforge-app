export interface HostedReferenceUcscTrackTargetV1 {
  readonly genomeId: string;
  readonly hubUrl?: string;
}

export interface HostedReferenceUcscTrackTargetEntryV1 {
  readonly id: string;
  readonly target: HostedReferenceUcscTrackTargetV1 | null;
}

function target(genomeId: string, hubUrl?: string): HostedReferenceUcscTrackTargetV1 {
  return Object.freeze({
    genomeId,
    ...(hubUrl ? { hubUrl } : {}),
  });
}

const HOSTED_REFERENCE_UCSC_TRACK_TARGET_ENTRIES_V1: ReadonlyArray<HostedReferenceUcscTrackTargetEntryV1> =
  [
    { id: 'grch38', target: target('hg38') },
    { id: 'hs1', target: target('hs1') },
    { id: 'hg19', target: target('hg19') },
    { id: 'mm39', target: target('GCF_000001635.27') },
    { id: 'mm10', target: target('mm10') },
    { id: 'rn8', target: target('GCF_036323735.1') },
    { id: 'rn7', target: target('GCF_015227675.2') },
    { id: 'grcz12tu', target: target('GCF_049306965.2') },
    { id: 'danRer11', target: target('GCF_000002035.6') },
    { id: 'dm6', target: target('GCF_000001215.4') },
    { id: 'ce11', target: target('ce11') },
    { id: 'sacCer3', target: target('sacCer3') },
    { id: 'pombeAsm294v3', target: target('GCF_000002945.2') },
    { id: 'xenTro10', target: target('GCF_000004195.4') },
    { id: 'xenLae10', target: target('GCF_017654675.1') },
    { id: 'grcg7b', target: target('GCF_016699485.2') },
    { id: 'canFam4', target: target('GCF_011100685.1') },
    { id: 'susScrHxylV2', target: target('GCF_054392235.1') },
    { id: 'arsUcd2', target: target('GCF_002263795.3') },
    { id: 'criGriPicrh1', target: target('GCF_003668045.3') },
    { id: 't2tMmu8v2', target: target('GCF_049350105.2') },
    { id: 't2tMfa8v11', target: null },
    { id: 'rheMac10', target: target('GCF_003339765.1') },
    { id: 'mPanTro3v21', target: target('GCF_028858775.2') },
    { id: 'panTro6', target: target('panTro6') },
    { id: 'mGorGor1v21', target: target('GCF_029281585.2') },
    { id: 'mOryCun11', target: target('GCF_964237555.1') },
    { id: 'oarRambouilletV3', target: target('GCF_016772045.2') },
    { id: 'equCabTbT2t', target: target('GCF_041296265.1') },
    { id: 'medakaHdRr31', target: target('GCF_053564925.1') },
    { id: 'grcz12ab', target: null },
    { id: 'galGal6', target: target('galGal6') },
    { id: 'canFam6', target: target('GCF_000002285.5') },
    { id: 'canFam3', target: target('GCF_000002285.3') },
    { id: 'susScr11', target: target('GCF_000003025.6') },
    { id: 'bosTau9', target: target('GCF_002263795.1') },
    { id: 'pomBase', target: target('GCF_000002945.1') },
    { id: 'smedA2h1', target: null },
    { id: 'tair10', target: target('GCF_000001735.4') },
    { id: 'agis1', target: target('GCF_034140825.1') },
    { id: 'irgsp1', target: target('GCF_001433935.1') },
    { id: 'zmB73v5', target: target('GCF_902167145.1') },
    { id: 'sbicolorNcbiv3', target: target('GCF_000003195.3') },
    { id: 'ntK326', target: target('GCF_000715075.1') },
    { id: 'nibenKlab', target: null },
    { id: 'spirodelaPolyrhiza', target: null },
    { id: 'tomatoSlmR21', target: target('GCF_036512215.1') },
    { id: 'soybeanV4', target: target('GCF_000004515.6') },
    { id: 'wheatRefseqV21', target: target('GCF_018294505.1') },
    { id: 'ecoliK12Mg1655', target: target('GCF_000005845.2') },
    { id: 'ecoliBl21De3', target: target('GCF_000022665.1') },
    { id: 'bacillus168', target: target('GCF_000009045.1') },
    { id: 'pputidaKt2440', target: target('GCF_000007565.2') },
    { id: 'cglutamicumAtcc13032', target: target('GCF_000011325.1') },
    { id: 'scoelicolorA32', target: null },
    { id: 'kphaffiiGs115', target: target('GCF_000027005.1') },
    { id: 'kphaffiiCbs7435', target: null },
    { id: 'candidaSC5314', target: target('GCF_000182965.3') },
    { id: 'anidulansFgscA4', target: target('GCF_000011425.1') },
    { id: 'mtbH37Rv', target: target('GCF_000195955.2') },
    { id: 'paeruginosaPao1', target: target('GCF_000006765.1') },
    { id: 'saureusNctc8325', target: target('GCF_000013425.1') },
    { id: 'saureusUsa300Fpr3757', target: null },
    { id: 'salmonellaLt2', target: target('GCF_000006945.2') },
    { id: 'sarsCov2WuhanHu1', target: target('GCF_009858895.2') },
    { id: 'pfalciparum3d7', target: target('GCF_000002765.6') },
    { id: 'agambiaeF1', target: target('GCF_943734735.2') },
  ];

export const HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1 = Object.freeze(
  HOSTED_REFERENCE_UCSC_TRACK_TARGET_ENTRIES_V1.map((entry) => Object.freeze(entry))
);

const HOSTED_REFERENCE_UCSC_TRACK_TARGET_BY_ID_V1 = new Map(
  HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1.map(({ id, target: exactTarget }) => [id, exactTarget])
);

export function hostedReferenceUcscTrackTargetForAssembly(
  assemblyId: string
): HostedReferenceUcscTrackTargetV1 | null {
  return HOSTED_REFERENCE_UCSC_TRACK_TARGET_BY_ID_V1.get(assemblyId) ?? null;
}
