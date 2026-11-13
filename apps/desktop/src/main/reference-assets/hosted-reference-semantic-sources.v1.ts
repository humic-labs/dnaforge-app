import type { ReferenceSemanticSourceV1, SemanticEvidenceSourceV1 } from '@waypoint/genome-data';

export interface HostedReferenceSemanticSourceCatalogEntryV1 {
  readonly id: string;
  readonly assemblyAccession: string;
  readonly evidence: readonly SemanticEvidenceSourceV1[];
  readonly memberSourcesByChrom: Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>>;
  readonly defaultNuclearDisposition: 'unsupported';
  readonly discoveryAudit: HostedReferenceSemanticDiscoveryAuditV1;
}

export interface HostedReferenceSemanticDiscoveryAuditV1 {
  readonly contract: 'dnaforge-semantic-discovery-audit.v1';
  readonly assemblyAccession: string;
  readonly reviewedAt: '2026-09-17';
  readonly outcome: 'resolved' | 'partially-resolved' | 'unresolved-after-audit';
  readonly checks: readonly HostedReferenceSemanticDiscoveryCheckV1[];
  readonly evidenceIds: readonly string[];
}

export type HostedReferenceSemanticDiscoveryCheckV1 =
  | 'producer-annotation'
  | 'ncbi-feature-table'
  | 'ncbi-assembly-gaps'
  | 'ncbi-ideogram'
  | 'ucsc-cytobands'
  | 'primary-literature'
  | 'organism-database';

type HostedReferenceSemanticSourceCatalogBaseV1 = Omit<
  HostedReferenceSemanticSourceCatalogEntryV1,
  'discoveryAudit'
>;

type IntervalRow = readonly [chrom: string, start: number, end: number];
type ReviewedCentromereRow = readonly [
  chrom: string,
  startBp: number,
  endBp: number,
  topology: 'internal' | 'terminal-start' | 'terminal-end',
];
type ReviewedCytogeneticMorphologyRow = readonly [
  chrom: string,
  centromereClass: 'metacentric' | 'submetacentric' | 'acrocentric' | 'telocentric',
  shortArmAt: 'start' | 'end',
];
type NcbiIdeogramArmRow = Readonly<{ arm: 'p' | 'q'; start: number; stop: number }>;
type NcbiIdeogramChromosomeRow = readonly [chrom: string, records: readonly NcbiIdeogramArmRow[]];

const GRCH38_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 122_026_460, 125_184_587],
  ['chr2', 92_188_146, 94_090_557],
  ['chr3', 90_772_459, 93_655_574],
  ['chr4', 49_708_101, 51_743_951],
  ['chr5', 46_485_901, 50_059_807],
  ['chr6', 58_553_889, 59_829_934],
  ['chr7', 58_169_654, 60_828_234],
  ['chr8', 44_033_745, 45_877_265],
  ['chr9', 43_236_168, 45_518_558],
  ['chr10', 39_686_683, 41_593_521],
  ['chr11', 51_078_349, 54_425_074],
  ['chr12', 34_769_408, 37_185_252],
  ['chr13', 16_000_001, 18_051_248],
  ['chr14', 16_000_001, 18_173_523],
  ['chr15', 17_000_001, 19_725_254],
  ['chr16', 36_311_159, 38_280_682],
  ['chr17', 22_813_680, 26_885_980],
  ['chr18', 15_460_900, 20_861_206],
  ['chr19', 24_498_981, 27_190_874],
  ['chr20', 26_436_233, 30_038_348],
  ['chr21', 10_864_561, 12_915_808],
  ['chr22', 12_954_789, 15_054_318],
  ['chrX', 58_605_580, 62_412_542],
  ['chrY', 10_316_945, 10_544_039],
];

const HS1_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 121_796_048, 126_300_487],
  ['chr2', 92_333_543, 94_673_023],
  ['chr3', 91_738_002, 96_415_026],
  ['chr4', 49_705_154, 55_199_795],
  ['chr5', 47_039_134, 49_596_625],
  ['chr6', 58_286_706, 61_058_390],
  ['chr7', 60_414_372, 63_714_499],
  ['chr8', 44_215_832, 46_325_080],
  ['chr9', 44_951_775, 47_582_595],
  ['chr10', 39_633_793, 41_664_589],
  ['chr11', 51_035_789, 54_450_838],
  ['chr12', 34_620_838, 37_202_490],
  ['chr13', 15_547_593, 17_498_291],
  ['chr14', 10_092_112, 12_708_411],
  ['chr15', 16_678_794, 17_694_466],
  ['chr16', 35_848_286, 37_829_521],
  ['chr17', 23_892_419, 27_486_939],
  ['chr18', 15_965_699, 20_933_550],
  ['chr19', 25_817_676, 29_768_171],
  ['chr20', 26_925_852, 29_099_655],
  ['chr21', 10_962_853, 11_306_205],
  ['chr22', 12_788_180, 15_711_065],
  ['chrX', 57_820_107, 60_927_025],
  ['chrY', 10_565_750, 10_883_085],
];

const SACCER3_CENTROMERES: readonly IntervalRow[] = [
  ['chrI', 151_465, 151_582],
  ['chrII', 238_207, 238_323],
  ['chrIII', 114_385, 114_501],
  ['chrIV', 449_711, 449_821],
  ['chrV', 151_987, 152_104],
  ['chrVI', 148_510, 148_627],
  ['chrVII', 496_920, 497_038],
  ['chrVIII', 105_586, 105_703],
  ['chrIX', 355_629, 355_745],
  ['chrX', 436_307, 436_425],
  ['chrXI', 440_129, 440_246],
  ['chrXII', 150_828, 150_947],
  ['chrXIII', 268_031, 268_149],
  ['chrXIV', 628_758, 628_875],
  ['chrXV', 326_584, 326_702],
  ['chrXVI', 555_957, 556_073],
];

const RHEMAC10_CENTROMERES: readonly IntervalRow[] = [
  ['chrY', 11_253_683, 11_753_682],
  ['chr1', 86_650_676, 87_650_675],
  ['chr2', 65_815_394, 66_815_393],
  ['chr3', 55_869_408, 56_869_407],
  ['chr4', 49_585_986, 50_585_985],
  ['chr5', 82_346_005, 83_346_004],
  ['chr6', 46_617_455, 47_617_454],
  ['chr7', 59_885_863, 60_885_862],
  ['chr8', 45_193_781, 46_193_780],
  ['chr9', 42_259_455, 43_259_454],
  ['chr10', 36_756_998, 37_756_997],
  ['chr11', 36_929_714, 37_929_713],
  ['chr12', 23_625_063, 24_625_062],
  ['chr13', 20_248_652, 21_248_651],
  ['chr14', 60_648_126, 61_648_125],
  ['chr15', 18_927_258, 19_927_257],
  ['chr16', 20_831_078, 21_831_077],
  ['chr17', 41_090_263, 42_090_262],
  ['chr18', 25_964_658, 26_964_657],
  ['chr19', 24_310_527, 25_310_526],
  ['chr20', 30_488_989, 31_488_988],
];

const GRCZ12TU_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 29_986_117, 32_748_083],
  ['chr2', 13_577_869, 16_499_485],
  ['chr3', 45_976_273, 48_845_563],
  ['chr4', 29_466_511, 31_269_887],
  ['chr5', 57_043_641, 58_982_898],
  ['chr6', 22_126_921, 24_081_351],
  ['chr7', 60_398_714, 62_135_830],
  ['chr8', 40_073_046, 42_174_793],
  ['chr9', 15_985_010, 17_413_746],
  ['chr10', 12_165_930, 14_325_385],
  ['chr11', 15_344_211, 17_227_504],
  ['chr12', 14_659_477, 16_134_978],
  ['chr13', 21_016_548, 22_712_401],
  ['chr14', 22_460_371, 24_410_300],
  ['chr15', 12_550_713, 13_553_824],
  ['chr16', 17_892_332, 19_736_550],
  ['chr17', 41_819_314, 43_479_457],
  ['chr18', 33_027_490, 35_005_092],
  ['chr19', 19_338_246, 20_773_246],
  ['chr20', 12_849_944, 14_129_478],
  ['chr21', 35_992_110, 37_099_943],
  ['chr22', 28_292_169, 29_686_245],
  ['chr23', 12_618_608, 14_232_602],
  ['chr24', 12_680_457, 14_194_505],
  ['chr25', 27_104_684, 29_128_822],
];

const TAIR10_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 14_080_000, 15_610_000],
  ['chr2', 2_930_000, 3_950_000],
  ['chr3', 13_160_000, 14_550_000],
  ['chr4', 2_000_000, 4_260_000],
  ['chr5', 10_930_000, 12_660_000],
];

const AGIS1_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 16_808_000, 17_441_000],
  ['chr2', 13_619_000, 14_176_000],
  ['chr3', 20_047_000, 20_551_000],
  ['chr4', 9_652_000, 10_077_000],
  ['chr5', 12_261_000, 12_840_000],
  ['chr6', 15_689_000, 16_316_000],
  ['chr7', 12_108_000, 12_457_000],
  ['chr8', 12_988_000, 13_761_000],
  ['chr9', 6_784_000, 7_200_000],
  ['chr10', 8_326_000, 8_660_000],
  ['chr11', 12_803_000, 14_000_000],
  ['chr12', 11_939_000, 12_473_000],
];

const T2T_MMU8V2_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 86_606_158, 103_987_289],
  ['chr2', 66_529_796, 74_633_310],
  ['chr3', 59_679_466, 69_065_842],
  ['chr4', 50_826_071, 63_849_967],
  ['chr5', 81_690_308, 94_329_478],
  ['chr6', 47_264_355, 57_909_976],
  ['chr7', 60_608_622, 72_261_798],
  ['chr8', 45_355_952, 57_324_191],
  ['chr9', 38_843_258, 50_667_718],
  ['chr10', 42_474_644, 55_917_906],
  ['chr11', 37_200_970, 46_105_786],
  ['chr12', 29_873_217, 42_503_158],
  ['chr13', 26_383_181, 37_728_566],
  ['chr14', 59_843_755, 69_507_648],
  ['chr15', 25_225_458, 35_625_788],
  ['chr16', 24_070_338, 35_871_875],
  ['chr17', 42_413_818, 55_325_376],
  ['chr18', 26_462_070, 37_635_337],
  ['chr19', 25_087_078, 38_934_530],
  ['chr20', 30_941_383, 41_429_803],
  ['chrX', 58_168_007, 69_396_195],
  ['chrY', 13_577_836, 18_198_959],
];

const POMBE_ASM294V3_CENTROMERES: readonly IntervalRow[] = [
  ['chrI', 3_753_686, 3_789_421],
  ['chrII', 1_602_263, 1_644_747],
  ['chrIII', 1_070_903, 1_137_003],
];

const XEN_LAE10_CENTROMERES: readonly IntervalRow[] = [
  ['chr1L', 96_582_536, 97_638_551],
  ['chr1S', 78_922_130, 79_008_823],
  ['chr2L', 70_076_389, 70_258_699],
  ['chr2S', 54_347_978, 55_190_352],
  ['chr3L', 19_140_049, 19_259_400],
  ['chr3S', 18_944_075, 19_466_505],
  ['chr4L', 36_375_516, 36_534_915],
  ['chr4S', 29_328_671, 29_423_025],
  ['chr5L', 63_210_646, 63_362_980],
  ['chr5S', 54_099_924, 54_162_122],
  ['chr6L', 78_555_074, 78_657_199],
  ['chr6S', 55_253_614, 55_304_911],
  ['chr7L', 58_158_940, 58_355_130],
  ['chr7S', 47_582_934, 47_603_112],
  ['chr8L', 21_900_593, 22_069_988],
  ['chr8S', 49_180_152, 49_237_882],
  ['chr9_10L', 23_812_947, 23_941_927],
  ['chr9_10S', 25_065_099, 25_179_840],
];

const MPANTRO3V21_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 101_355_931, 105_078_016],
  ['chr2', 95_371_795, 96_892_147],
  ['chr3', 78_976_583, 81_373_970],
  ['chr4', 64_506_857, 66_595_708],
  ['chr5', 64_391_884, 65_466_266],
  ['chr6', 68_860_121, 70_510_584],
  ['chr7', 52_326_904, 54_529_873],
  ['chr8', 52_315_186, 53_714_297],
  ['chr9', 54_273_390, 56_404_620],
  ['chr10', 58_461_602, 60_698_619],
  ['chr11', 53_076_097, 54_794_760],
  ['chr12', 28_498_122, 31_279_666],
  ['chr13', 33_198_526, 34_034_017],
  ['chr14', 15_582_233, 17_149_638],
  ['chr15', 15_192_905, 17_140_990],
  ['chr16', 13_813_511, 15_877_441],
  ['chr17', 13_561_461, 15_829_470],
  ['chr18', 41_035_816, 42_685_116],
  ['chr19', 40_919_954, 44_878_717],
  ['chr20', 27_214_610, 30_242_791],
  ['chr21', 32_946_743, 34_927_143],
  ['chr22', 12_502_745, 14_044_959],
  ['chr23', 13_267_811, 18_666_999],
  ['chrX', 58_606_782, 60_257_124],
  ['chrY', 13_138_472, 14_429_665],
];

const MGORGOR1V21_CENTROMERES: readonly IntervalRow[] = [
  ['chr1', 108_411_325, 111_910_309],
  ['chr2', 101_285_979, 104_489_663],
  ['chr3', 75_635_420, 78_094_429],
  ['chr4', 71_532_156, 78_693_863],
  ['chr5', 76_056_492, 80_734_441],
  ['chr6', 66_743_687, 72_076_149],
  ['chr7', 74_645_547, 77_769_723],
  ['chr8', 73_335_517, 79_748_613],
  ['chr9', 56_445_557, 61_777_937],
  ['chr10', 64_043_897, 66_751_636],
  ['chr11', 33_401_710, 33_508_002],
  ['chr12', 26_295_648, 29_036_800],
  ['chr13', 18_139_064, 22_884_300],
  ['chr14', 26_870_199, 29_409_803],
  ['chr15', 37_990_960, 44_099_811],
  ['chr16', 18_319_906, 19_805_014],
  ['chr17', 33_191_504, 35_435_240],
  ['chr18', 69_916_649, 73_774_049],
  ['chr19', 59_933_142, 65_144_942],
  ['chr20', 30_822_990, 38_091_595],
  ['chr21', 36_501_140, 41_679_033],
  ['chr22', 11_868_824, 15_121_200],
  ['chr23', 10_473_015, 14_819_747],
  ['chrX', 68_907_035, 72_614_336],
  ['chrY', 20_584_874, 24_867_439],
];

const RN7_IDEOGRAM_ARMS: readonly NcbiIdeogramChromosomeRow[] = [
  [
    'chr1',
    [
      { arm: 'p', start: 0, stop: 40_566_263 },
      { arm: 'q', start: 40_566_263, stop: 260_522_015 },
    ],
  ],
  ['chr2', [{ arm: 'q', start: 0, stop: 249_053_266 }]],
  [
    'chr3',
    [
      { arm: 'p', start: 0, stop: 20_835_736 },
      { arm: 'q', start: 20_835_736, stop: 169_034_230 },
    ],
  ],
  ['chr4', [{ arm: 'q', start: 0, stop: 182_687_753 }]],
  ['chr5', [{ arm: 'q', start: 0, stop: 166_875_057 }]],
  ['chr6', [{ arm: 'q', start: 0, stop: 140_994_060 }]],
  ['chr7', [{ arm: 'q', start: 0, stop: 135_012_527 }]],
  ['chr8', [{ arm: 'q', start: 0, stop: 123_900_183 }]],
  ['chr9', [{ arm: 'q', start: 0, stop: 114_175_308 }]],
  ['chr10', [{ arm: 'q', start: 0, stop: 107_211_141 }]],
  [
    'chr11',
    [
      { arm: 'p', start: 0, stop: 15_631_539 },
      { arm: 'q', start: 15_631_539, stop: 86_241_446 },
    ],
  ],
  [
    'chr12',
    [
      { arm: 'p', start: 0, stop: 12_092_628 },
      { arm: 'q', start: 12_092_628, stop: 46_669_028 },
    ],
  ],
  [
    'chr13',
    [
      { arm: 'p', start: 0, stop: 26_567_172 },
      { arm: 'q', start: 26_567_172, stop: 106_807_693 },
    ],
  ],
  [
    'chr14',
    [
      { arm: 'p', start: 0, stop: 46_061_573 },
      { arm: 'q', start: 46_061_573, stop: 104_886_042 },
    ],
  ],
  [
    'chr15',
    [
      { arm: 'p', start: 0, stop: 48_259_541 },
      { arm: 'q', start: 48_259_541, stop: 101_769_106 },
    ],
  ],
  [
    'chr16',
    [
      { arm: 'p', start: 0, stop: 39_747_025 },
      { arm: 'q', start: 39_747_025, stop: 84_729_063 },
    ],
  ],
  [
    'chr17',
    [
      { arm: 'p', start: 0, stop: 43_391_220 },
      { arm: 'q', start: 43_391_220, stop: 86_533_672 },
    ],
  ],
  [
    'chr18',
    [
      { arm: 'p', start: 0, stop: 35_398_137 },
      { arm: 'q', start: 35_398_137, stop: 83_828_826 },
    ],
  ],
  [
    'chr19',
    [
      { arm: 'p', start: 0, stop: 21_659_222 },
      { arm: 'q', start: 21_659_222, stop: 57_337_601 },
    ],
  ],
  [
    'chr20',
    [
      { arm: 'p', start: 0, stop: 25_570_188 },
      { arm: 'q', start: 25_570_188, stop: 54_435_886 },
    ],
  ],
  ['chrX', [{ arm: 'q', start: 0, stop: 152_453_650 }]],
  ['chrY', [{ arm: 'q', start: 0, stop: 18_315_840 }]],
];

function providerEvidence(id: string, assemblyAccession: string): SemanticEvidenceSourceV1 {
  return {
    id: `${id}-assembly-record`,
    kind: 'reviewed-assertion',
    provider: 'NCBI Datasets',
    assemblyAccession,
    sourceUrl: `https://www.ncbi.nlm.nih.gov/datasets/genome/${assemblyAccession}/`,
    adapterContract: 'dnaforge-provider-record-citation.v1',
  };
}

function genericEntry(
  id: string,
  assemblyAccession: string,
  discoveryEvidence: GenericDiscoveryEvidenceSpec
): HostedReferenceSemanticSourceCatalogBaseV1 {
  return {
    id,
    assemblyAccession,
    evidence: [
      providerEvidence(id, assemblyAccession),
      {
        id: `${id}-ucsc-cytobands`,
        kind: 'ucsc-cytobands',
        provider: 'UCSC GenArk',
        assemblyAccession,
        sourceUrl: discoveryEvidence.ucsc.sourceUrl,
        sha256: discoveryEvidence.ucsc.sha256,
        byteLength: discoveryEvidence.ucsc.byteLength,
        mediaType: 'application/octet-stream',
        adapterContract: 'dnaforge-ucsc-cytoband-adapter.v1',
      },
      {
        id: `${id}-agp`,
        kind: 'ncbi-assembly-gaps',
        provider: 'UCSC GenArk / NCBI AGP',
        assemblyAccession,
        sourceUrl: discoveryEvidence.agp.sourceUrl,
        sha256: discoveryEvidence.agp.sha256,
        byteLength: discoveryEvidence.agp.byteLength,
        mediaType: 'application/gzip',
        adapterContract: 'dnaforge-ncbi-agp-discovery-adapter.v1',
      },
    ],
    memberSourcesByChrom: {},
    defaultNuclearDisposition: 'unsupported',
  };
}

interface GenericDiscoveryEvidenceSpec {
  readonly ucsc: {
    readonly sourceUrl: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly agp: {
    readonly sourceUrl: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
}

function ucscSources(
  rows: readonly IntervalRow[],
  evidenceId: string
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  return Object.fromEntries(
    rows.map(([chrom, start, end]) => [
      chrom,
      [
        {
          kind: 'ucsc-cytobands' as const,
          evidenceId,
          records: [{ start, end, stain: 'acen' }],
        },
      ],
    ])
  );
}

function gffSources(
  rows: readonly IntervalRow[],
  evidenceId: string
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  return Object.fromEntries(
    rows.map(([chrom, start, end]) => [
      chrom,
      [
        {
          kind: 'gff3-features' as const,
          evidenceId,
          records: [{ type: 'centromere', start, end }],
        },
      ],
    ])
  );
}

function ncbiGapSources(
  rows: readonly IntervalRow[],
  evidenceId: string,
  terminalStart = false
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  return Object.fromEntries(
    rows.map(([chrom, start, end]) => [
      chrom,
      [
        {
          kind: 'ncbi-assembly-gaps' as const,
          evidenceId,
          records: [{ gapType: 'centromere', start, end }],
        },
        ...(terminalStart
          ? [
              {
                kind: 'reviewed-centromere-topology' as const,
                evidenceId: `${evidenceId}-terminal-adjudication`,
                topology: 'terminal-start' as const,
              },
            ]
          : []),
      ],
    ])
  );
}

const MM39_TERMINAL_ROWS: readonly IntervalRow[] = [
  ...Array.from({ length: 19 }, (_, index) => [`chr${index + 1}`, 110_001, 3_000_000] as const),
  ['chrX', 110_001, 3_000_000],
];

const MM39_SOURCES = {
  ...ncbiGapSources(MM39_TERMINAL_ROWS, 'mm39-ncbi-gaps', true),
  chrY: [
    {
      kind: 'gff3-features' as const,
      evidenceId: 'mm39-producer-gff',
      records: [{ type: 'centromere', start: 4_072_167, end: 4_161_965 }],
    },
  ],
};

const RN8_CENTROMERES: readonly ReviewedCentromereRow[] = [
  ['chr2', 2_500_000, 3_000_000, 'terminal-start'],
  ['chr4', 900_000, 1_300_000, 'terminal-start'],
  ['chr5', 2_300_000, 6_700_000, 'terminal-start'],
  ['chr6', 2_500_000, 7_500_000, 'terminal-start'],
  ['chr7', 200_000, 600_000, 'terminal-start'],
  ['chr8', 2_500_000, 7_500_000, 'terminal-start'],
  ['chr10', 300_000, 700_000, 'terminal-start'],
  ['chr11', 1_800_000, 5_300_000, 'internal'],
  ['chr13', 30_500_000, 32_500_000, 'internal'],
  ['chr14', 48_500_000, 52_500_000, 'internal'],
  ['chr15', 49_000_000, 51_500_000, 'internal'],
  ['chr16', 42_000_000, 43_600_000, 'internal'],
  ['chr17', 45_000_000, 49_000_000, 'internal'],
  ['chr18', 38_600_000, 40_400_000, 'internal'],
  ['chr19', 39_000_000, 39_600_000, 'internal'],
  ['chr20', 26_200_000, 26_700_000, 'internal'],
  ['chrX', 2_400_000, 3_900_000, 'terminal-start'],
];

const RN8_SCHEMATIC_MORPHOLOGIES: readonly ReviewedCytogeneticMorphologyRow[] = [
  ['chr1', 'submetacentric', 'start'],
  ['chr3', 'acrocentric', 'start'],
  ['chr9', 'telocentric', 'start'],
  ['chr12', 'acrocentric', 'start'],
  ['chrY', 'telocentric', 'start'],
];

function reviewedCentromereSources(
  rows: readonly ReviewedCentromereRow[],
  evidenceId: string
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  return Object.fromEntries(
    rows.map(([chrom, startBp, endBp, topology]) => [
      chrom,
      [
        {
          kind: 'reviewed-centromere-region' as const,
          evidenceId,
          interval: { startBp, endBp },
        },
        ...(topology === 'internal'
          ? []
          : [
              {
                kind: 'reviewed-centromere-topology' as const,
                evidenceId,
                topology,
              },
            ]),
      ],
    ])
  );
}

function reviewedInternalCentromereSources(
  rows: readonly IntervalRow[],
  evidenceId: string,
  assemblyIdentityEvidenceId?: string
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  const sources = reviewedCentromereSources(
    rows.map(([chrom, startBp, endBp]) => [chrom, startBp, endBp, 'internal']),
    evidenceId
  );
  if (!assemblyIdentityEvidenceId) return sources;
  return Object.fromEntries(
    Object.entries(sources).map(([chrom, memberSources]) => [
      chrom,
      [
        {
          kind: 'reviewed-architecture' as const,
          evidenceId: assemblyIdentityEvidenceId,
          value: 'localized' as const,
        },
        ...memberSources,
      ],
    ])
  );
}

function ncbiIdeogramSources(
  rows: readonly NcbiIdeogramChromosomeRow[],
  evidenceId: string
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  return Object.fromEntries(
    rows.map(([chrom, records]) => [
      chrom,
      [{ kind: 'ncbi-ideogram-arms' as const, evidenceId, records }],
    ])
  );
}

function reviewedCytogeneticMorphologySources(
  rows: readonly ReviewedCytogeneticMorphologyRow[],
  evidenceId: string
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  return Object.fromEntries(
    rows.map(([chrom, centromereClass, shortArmAt]) => [
      chrom,
      [
        {
          kind: 'reviewed-cytogenetic-morphology' as const,
          evidenceId,
          centromereClass,
          shortArmAt,
        },
      ],
    ])
  );
}

function mergeMemberSourcesByChrom(
  ...sources: ReadonlyArray<Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>>>
): Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> {
  const merged: Record<string, ReferenceSemanticSourceV1[]> = {};
  for (const source of sources) {
    for (const [chrom, entries] of Object.entries(source)) {
      merged[chrom] = [...(merged[chrom] ?? []), ...entries];
    }
  }
  return merged;
}

const DM6_MEMBER_SOURCES: Readonly<Record<string, readonly ReferenceSemanticSourceV1[]>> = {
  chr2L: [
    {
      kind: 'reviewed-chromosome-arm',
      evidenceId: 'dm6-flybase-r6',
      groupId: 'chr2',
      segmentIndex: 0,
      orientation: 'telomere-to-centromere',
    },
  ],
  chr2R: [
    {
      kind: 'reviewed-chromosome-arm',
      evidenceId: 'dm6-flybase-r6',
      groupId: 'chr2',
      segmentIndex: 1,
      orientation: 'centromere-to-telomere',
    },
  ],
  chr3L: [
    {
      kind: 'reviewed-chromosome-arm',
      evidenceId: 'dm6-flybase-r6',
      groupId: 'chr3',
      segmentIndex: 0,
      orientation: 'telomere-to-centromere',
    },
  ],
  chr3R: [
    {
      kind: 'reviewed-chromosome-arm',
      evidenceId: 'dm6-flybase-r6',
      groupId: 'chr3',
      segmentIndex: 1,
      orientation: 'centromere-to-telomere',
    },
  ],
  ...Object.fromEntries(
    ['chr4', 'chrX', 'chrY'].map((chrom) => [
      chrom,
      [
        {
          kind: 'reviewed-architecture' as const,
          evidenceId: 'dm6-centromere-architecture',
          value: 'localized' as const,
        },
      ],
    ])
  ),
};

const SPECIALIZED: readonly HostedReferenceSemanticSourceCatalogBaseV1[] = [
  {
    id: 'grch38',
    assemblyAccession: 'GCF_000001405.40',
    evidence: [
      providerEvidence('grch38', 'GCF_000001405.40'),
      {
        id: 'grch38-ucsc-cytobands',
        kind: 'ucsc-cytobands',
        provider: 'UCSC Genome Browser',
        assemblyAccession: 'GCF_000001405.40',
        sourceUrl: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBand.txt.gz',
        sha256: 'ddea653eef98582c36c17d082c46f984f98ba5fe68e27a3bf6bafbd8eb98b8fb',
        byteLength: 31_298,
        mediaType: 'text/tab-separated-values',
        adapterContract: 'dnaforge-ucsc-cytoband-adapter.v1',
      },
      {
        id: 'grch38-producer-gff',
        kind: 'gff3-features',
        provider: 'NCBI RefSeq',
        assemblyAccession: 'GCF_000001405.40',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/',
        sha256: '6f6da659257e957387360de699ee3f45206ada3edd5fc233399773fc98db7d16',
        byteLength: 101_588_741,
        mediaType: 'application/gzip',
        adapterContract: 'dnaforge-gff3-semantic-adapter.v1',
      },
    ],
    memberSourcesByChrom: gffSources(GRCH38_CENTROMERES, 'grch38-producer-gff'),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'sacCer3',
    assemblyAccession: 'GCF_000146045.2',
    evidence: [
      providerEvidence('sacCer3', 'GCF_000146045.2'),
      {
        id: 'sacCer3-producer-gff',
        kind: 'gff3-features',
        provider: 'NCBI RefSeq / SGD',
        assemblyAccession: 'GCF_000146045.2',
        sourceUrl:
          'https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/146/045/GCF_000146045.2_R64/GCF_000146045.2_R64_genomic.gff.gz',
        sha256: 'bbcb56dec2d2a00101fb85be4752fbda9895e27023e0c5e08340fc30d0ad5510',
        mediaType: 'application/gzip',
        adapterContract: 'dnaforge-gff3-semantic-adapter.v1',
      },
    ],
    memberSourcesByChrom: gffSources(SACCER3_CENTROMERES, 'sacCer3-producer-gff'),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'ce11',
    assemblyAccession: 'GCF_000002985.6',
    evidence: [
      providerEvidence('ce11', 'GCF_000002985.6'),
      {
        id: 'ce11-holocentric-primary-literature',
        kind: 'reviewed-assertion',
        provider: 'Journal of Cell Biology',
        assemblyAccession: 'GCF_000002985.6',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2192032/',
        adapterContract: 'dnaforge-reviewed-architecture-assertion.v1',
      },
    ],
    memberSourcesByChrom: Object.fromEntries(
      ['chrI', 'chrII', 'chrIII', 'chrIV', 'chrV', 'chrX'].map((chrom) => [
        chrom,
        [
          {
            kind: 'reviewed-architecture' as const,
            evidenceId: 'ce11-holocentric-primary-literature',
            value: 'holocentric' as const,
          },
        ],
      ])
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'mm39',
    assemblyAccession: 'GCF_000001635.27',
    evidence: [
      providerEvidence('mm39', 'GCF_000001635.27'),
      {
        id: 'mm39-ncbi-gaps',
        kind: 'ncbi-assembly-gaps',
        provider: 'NCBI RefSeq',
        assemblyAccession: 'GCF_000001635.27',
        sourceUrl:
          'https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/001/635/GCF_000001635.27_GRCm39/GCF_000001635.27_GRCm39_genomic_gaps.txt.gz',
        sha256: 'cc5d2eef6d47d5ca277d82c25fc67cc58cf037e9a2ac87a907dbd3e62e56ead3',
        byteLength: 3_598,
        mediaType: 'application/gzip',
        adapterContract: 'dnaforge-ncbi-biological-gap-adapter.v1',
      },
      {
        id: 'mm39-ncbi-gaps-terminal-adjudication',
        kind: 'reviewed-assertion',
        provider: 'DNAForge reviewed source mapping',
        assemblyAccession: 'GCF_000001635.27',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1482656/',
        adapterContract: 'dnaforge-centromere-topology-adjudication.v1',
      },
      {
        id: 'mm39-producer-gff',
        kind: 'gff3-features',
        provider: 'NCBI RefSeq',
        assemblyAccession: 'GCF_000001635.27',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001635.27/',
        adapterContract: 'dnaforge-gff3-semantic-adapter.v1',
      },
    ],
    memberSourcesByChrom: MM39_SOURCES,
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'dm6',
    assemblyAccession: 'GCF_000001215.4',
    evidence: [
      providerEvidence('dm6', 'GCF_000001215.4'),
      {
        id: 'dm6-flybase-r6',
        kind: 'reviewed-assertion',
        provider: 'FlyBase / Genetics',
        assemblyAccession: 'GCF_000001215.4',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4352887/',
        adapterContract: 'dnaforge-chromosome-arm-assertion.v1',
      },
      {
        id: 'dm6-centromere-architecture',
        kind: 'reviewed-assertion',
        provider: 'PLOS Biology / Drosophila centromere study',
        assemblyAccession: 'GCF_000001215.4',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6516634/',
        adapterContract: 'dnaforge-reviewed-architecture-assertion.v1',
      },
    ],
    memberSourcesByChrom: DM6_MEMBER_SOURCES,
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'rn8',
    assemblyAccession: 'GCF_036323735.1',
    evidence: [
      providerEvidence('rn8', 'GCF_036323735.1'),
      {
        id: 'rn8-grcr8-centromere-table',
        kind: 'reviewed-assertion',
        provider: 'Genome Research / GRCr8 assembly authors',
        assemblyAccession: 'GCF_036323735.1',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11610589/',
        adapterContract: 'dnaforge-reviewed-centromere-region-table.v1',
      },
      {
        id: 'rn8-grcr8-cytogenetic-classification',
        kind: 'reviewed-assertion',
        provider: 'Genome Research / GRCr8 assembly authors',
        assemblyAccession: 'GCF_036323735.1',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11610589/',
        adapterContract: 'dnaforge-reviewed-cytogenetic-morphology.v1',
      },
    ],
    memberSourcesByChrom: mergeMemberSourcesByChrom(
      reviewedCentromereSources(RN8_CENTROMERES, 'rn8-grcr8-centromere-table'),
      reviewedCytogeneticMorphologySources(
        RN8_SCHEMATIC_MORPHOLOGIES,
        'rn8-grcr8-cytogenetic-classification'
      )
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'rheMac10',
    assemblyAccession: 'GCF_003339765.1',
    evidence: [
      providerEvidence('rheMac10', 'GCF_003339765.1'),
      {
        id: 'rheMac10-ncbi-gaps',
        kind: 'ncbi-assembly-gaps',
        provider: 'NCBI RefSeq',
        assemblyAccession: 'GCF_003339765.1',
        sourceUrl:
          'https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/003/339/765/GCF_003339765.1_Mmul_10/GCF_003339765.1_Mmul_10_genomic_gaps.txt.gz',
        sha256: '5a8808978e8ffa523d4b7bc0e3112628f5df4ad6a8c8404703c9b404730a80c2',
        byteLength: 3_428,
        mediaType: 'application/gzip',
        adapterContract: 'dnaforge-ncbi-biological-gap-adapter.v1',
      },
    ],
    memberSourcesByChrom: ncbiGapSources(RHEMAC10_CENTROMERES, 'rheMac10-ncbi-gaps'),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'hs1',
    assemblyAccession: 'GCF_009914755.1',
    evidence: [
      providerEvidence('hs1', 'GCF_009914755.1'),
      {
        id: 'hs1-ucsc-cytobands',
        kind: 'ucsc-cytobands',
        provider: 'UCSC Genome Browser',
        assemblyAccession: 'GCF_009914755.1',
        sourceUrl: 'https://api.genome.ucsc.edu/getData/track?genome=hs1;track=cytoBand',
        sha256: 'eaa8bb6a137ebb46809a8a4886ae18fea99351293b5ab7931eacb9353cdb0030',
        byteLength: 108_121,
        mediaType: 'application/json',
        adapterContract: 'dnaforge-ucsc-cytoband-adapter.v1',
      },
    ],
    memberSourcesByChrom: ucscSources(HS1_CENTROMERES, 'hs1-ucsc-cytobands'),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'grcz12tu',
    assemblyAccession: 'GCF_049306965.2',
    evidence: [
      providerEvidence('grcz12tu', 'GCF_049306965.2'),
      {
        id: 'grcz12tu-centromere-table-s7',
        kind: 'reviewed-assertion',
        provider: 'NHGRI assembly authors / Europe PMC',
        assemblyAccession: 'GCF_049306965.2',
        sourceUrl:
          'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC12667973/supplementaryFiles',
        sha256: 'f8aed3de3a9410b88bab8054b629f017698b67a300d305f904c27404e27aaf58',
        byteLength: 30_513_114,
        mediaType: 'application/zip',
        adapterContract: 'dnaforge-reviewed-centromere-region-table.v1:media-2.xlsx/table-s7',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      GRCZ12TU_CENTROMERES,
      'grcz12tu-centromere-table-s7'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'tair10',
    assemblyAccession: 'GCF_000001735.4',
    evidence: [
      providerEvidence('tair10', 'GCF_000001735.4'),
      {
        id: 'tair10-centromere-regions',
        kind: 'reviewed-assertion',
        provider: 'Genome Research / Arabidopsis centromere study',
        assemblyAccession: 'GCF_000001735.4',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5495068/',
        adapterContract: 'dnaforge-reviewed-centromere-region-table.v1:10kb-resolution',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      TAIR10_CENTROMERES,
      'tair10-centromere-regions'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'agis1',
    assemblyAccession: 'GCF_034140825.1',
    evidence: [
      providerEvidence('agis1', 'GCF_034140825.1'),
      {
        id: 'agis1-cenh3-centromere-table',
        kind: 'reviewed-assertion',
        provider: 'Molecular Plant / AGIS1 assembly authors',
        assemblyAccession: 'GCF_034140825.1',
        sourceUrl: 'https://ars.els-cdn.com/content/image/1-s2.0-S1674205223002198-mmc2.xlsx',
        sha256: 'fe391a7fa8a0443c29ef7ab64484816cac92d546568a3e71224cd4b7bd678f7a',
        byteLength: 70_359,
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        adapterContract: 'dnaforge-reviewed-centromere-region-table.v1:table-s1-cenh3',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      AGIS1_CENTROMERES,
      'agis1-cenh3-centromere-table'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 't2tMmu8v2',
    assemblyAccession: 'GCF_049350105.2',
    evidence: [
      providerEvidence('t2tMmu8v2', 'GCF_049350105.2'),
      {
        id: 't2tMmu8v2-alpha-satellite-regions',
        kind: 'reviewed-assertion',
        provider: 'T2T-MMU8 assembly authors',
        assemblyAccession: 'GCF_049350105.2',
        sourceUrl:
          'https://synplotter.sjtu.edu.cn/disk2/T2T-MMU8/release_v2.0/T2T-MMU8v2.0.alpha_satellite.bed',
        sha256: '209f575f374f783e11440cc45fa3e9e0968a1f6e70517014d781ca10661160a2',
        byteLength: 1_289,
        mediaType: 'text/bed',
        adapterContract: 'dnaforge-reviewed-centromere-region-table.v1:alpha-satellite',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      T2T_MMU8V2_CENTROMERES,
      't2tMmu8v2-alpha-satellite-regions'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'rn7',
    assemblyAccession: 'GCF_015227675.2',
    evidence: [
      providerEvidence('rn7', 'GCF_015227675.2'),
      {
        id: 'rn7-ncbi-ideogram',
        kind: 'ncbi-ideogram',
        provider: 'NCBI Genome Data Viewer',
        assemblyAccession: 'GCF_015227675.2',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/gdv/api/get-ideo/10116/GCF_015227675.2',
        sha256: '213612dac88a0a6c2be92ffc7d065597b2d6f81ce664079bc247f0575de678bb',
        byteLength: 42_017,
        mediaType: 'application/json',
        adapterContract: 'dnaforge-ncbi-ideogram-arm-adapter.v1',
      },
    ],
    memberSourcesByChrom: ncbiIdeogramSources(RN7_IDEOGRAM_ARMS, 'rn7-ncbi-ideogram'),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'pombeAsm294v3',
    assemblyAccession: 'GCF_000002945.2',
    evidence: [
      providerEvidence('pombeAsm294v3', 'GCF_000002945.2'),
      {
        id: 'pombe-centromere-regions',
        kind: 'reviewed-assertion',
        provider: 'PomBase',
        assemblyAccession: 'GCF_000002945.2',
        sourceUrl: 'https://www.pombase.org/faq/how-can-i-locate-centromeres',
        adapterContract: 'dnaforge-reviewed-centromere-region-table.v1:one-based-inclusive',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      POMBE_ASM294V3_CENTROMERES,
      'pombe-centromere-regions'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'xenLae10',
    assemblyAccession: 'GCF_017654675.1',
    evidence: [
      providerEvidence('xenLae10', 'GCF_017654675.1'),
      {
        id: 'xenLae10-cenpa-centromere-bed',
        kind: 'reviewed-assertion',
        provider: 'Genome Research / NCBI GEO',
        assemblyAccession: 'GCF_017654675.1',
        sourceUrl:
          'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE153nnn/GSE153058/suppl/GSE153058_xla_v10.2_cen.bed.gz',
        sha256: '5718bda492839587a910050956aa0e9e333fa10e52b29400524eeb780ea05f2d',
        byteLength: 276,
        mediaType: 'application/gzip',
        adapterContract: 'dnaforge-reviewed-centromere-region-table.v1:bed',
      },
      {
        id: 'xenLae10-cenpa-genome-identity',
        kind: 'reviewed-assertion',
        provider: 'Straight Lab Xenopus centromere study',
        assemblyAccession: 'GCF_017654675.1',
        sourceUrl:
          'https://raw.githubusercontent.com/straightlab/xenla-cen-dna-paper/master/config_xla_merge_final_SE_v9_yf_genome10.2.yaml',
        sha256: '4f8be8c868c38fdde64e4f1d6e3ae64a2d634886acca00fca71163c338c81841',
        byteLength: 1_244,
        mediaType: 'text/plain',
        adapterContract: 'dnaforge-xenopus-v10.2-to-v10.1-roster-adapter.v1',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      XEN_LAE10_CENTROMERES,
      'xenLae10-cenpa-centromere-bed',
      'xenLae10-cenpa-genome-identity'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'mPanTro3v21',
    assemblyAccession: 'GCF_028858775.2',
    evidence: [
      providerEvidence('mPanTro3v21', 'GCF_028858775.2'),
      {
        id: 'mPanTro3v21-t2t-censat-active-hor',
        kind: 'reviewed-assertion',
        provider: 'T2T-Browser / GenomeArk curated CenSat release',
        assemblyAccession: 'GCF_028858775.2',
        sourceUrl:
          'https://genomeark.s3.amazonaws.com/species/Pan_troglodytes/mPanTro3/assembly_curated/repeats/mPanTro3_v2.0_CenSat_v2.0.bb',
        sha256: '9089328913f6dc4465cb14f25e1ffbb8e99d7d1cccfd5c915affa0f831d60ddf',
        byteLength: 221_958,
        mediaType: 'application/octet-stream',
        adapterContract:
          'dnaforge-reviewed-centromere-region-table.v1:active-hor:primary-accession-projection',
      },
      {
        id: 'mPanTro3v21-t2t-alias-accessions',
        kind: 'reviewed-assertion',
        provider: 'T2T-Browser assembly alias table',
        assemblyAccession: 'GCF_028858775.2',
        sourceUrl:
          'https://raw.githubusercontent.com/marbl/T2T-Browser/main/T2Tgenomes/mPanTro3_v2.0/mPanTro3_v2.0.alias',
        sha256: '45fd62eda57c4b6d22f91b6393a69c6102891c8a8841451788f5e93fae9050af',
        byteLength: 3_762,
        mediaType: 'text/plain',
        adapterContract: 'dnaforge-t2t-assembly-alias-adapter.v1',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      MPANTRO3V21_CENTROMERES,
      'mPanTro3v21-t2t-censat-active-hor',
      'mPanTro3v21-t2t-alias-accessions'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
  {
    id: 'mGorGor1v21',
    assemblyAccession: 'GCF_029281585.2',
    evidence: [
      providerEvidence('mGorGor1v21', 'GCF_029281585.2'),
      {
        id: 'mGorGor1v21-t2t-censat-active-hor',
        kind: 'reviewed-assertion',
        provider: 'T2T-Browser / GenomeArk curated CenSat release',
        assemblyAccession: 'GCF_029281585.2',
        sourceUrl:
          'https://genomeark.s3.amazonaws.com/species/Gorilla_gorilla/mGorGor1/assembly_curated/repeats/mGorGor1_v2.0_CenSat_v2.0.bb',
        sha256: '511f5aff08dd38922de0c0fc1004ce79af30f607402f45966d6eafc314825b93',
        byteLength: 259_636,
        mediaType: 'application/octet-stream',
        adapterContract:
          'dnaforge-reviewed-centromere-region-table.v1:active-hor:primary-accession-projection',
      },
      {
        id: 'mGorGor1v21-t2t-alias-accessions',
        kind: 'reviewed-assertion',
        provider: 'T2T-Browser assembly alias table',
        assemblyAccession: 'GCF_029281585.2',
        sourceUrl:
          'https://raw.githubusercontent.com/marbl/T2T-Browser/main/T2Tgenomes/mGorGor1_v2.0/mGorGor1_v2.0.alias',
        sha256: '23ed3f2624f6901f2d6f54d17bebd03443cf675a0febbcc22b909ce026514f64',
        byteLength: 29_893,
        mediaType: 'text/plain',
        adapterContract: 'dnaforge-t2t-assembly-alias-adapter.v1',
      },
    ],
    memberSourcesByChrom: reviewedInternalCentromereSources(
      MGORGOR1V21_CENTROMERES,
      'mGorGor1v21-t2t-censat-active-hor',
      'mGorGor1v21-t2t-alias-accessions'
    ),
    defaultNuclearDisposition: 'unsupported',
  },
];

const GENERIC: readonly HostedReferenceSemanticSourceCatalogBaseV1[] = [
  genericEntry('xenTro10', 'GCF_000004195.4', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/004/195/GCF_000004195.4/bbi/GCF_000004195.4_UCB_Xtro_10.0.cytoBand.bb',
      sha256: '85fff20c625126cb1eacc8f985aa3e51277edef143646a8ad83375d2e3c05831',
      byteLength: 47_898,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/004/195/GCF_000004195.4/GCF_000004195.4.agp.gz',
      sha256: '6dd907680970b465aa52587c97b15f011655b739a638080ac47c196fc1c728dc',
      byteLength: 2_117,
    },
  }),
  genericEntry('zmB73v5', 'GCF_902167145.1', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/902/167/145/GCF_902167145.1/bbi/GCF_902167145.1_Zm-B73-REFERENCE-NAM-5.0.cytoBand.bb',
      sha256: 'ed0e73f077cb13d386857242c98dcd0965dc40f551c86f0616afd2dc6269c378',
      byteLength: 138_790,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/902/167/145/GCF_902167145.1/GCF_902167145.1.agp.gz',
      sha256: 'd651e578b702eec523ca2c253bee7dbac1be5df9575219ab6611f13bcc0f47c4',
      byteLength: 7_996,
    },
  }),
  genericEntry('mOryCun11', 'GCF_964237555.1', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/964/237/555/GCF_964237555.1/bbi/GCF_964237555.1_mOryCun1.1.cytoBand.bb',
      sha256: '98c0a046122ecb6074ade3d4fa543d9b142de29f8f053849a1fca473bf249c92',
      byteLength: 54_126,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/964/237/555/GCF_964237555.1/GCF_964237555.1.agp.gz',
      sha256: 'b76fea7045b2a7a7ef18e532f990e26b02515e1cf9c533e5ad130d6139be9fae',
      byteLength: 2_485,
    },
  }),
  genericEntry('oarRambouilletV3', 'GCF_016772045.2', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/016/772/045/GCF_016772045.2/bbi/GCF_016772045.2_ARS-UI_Ramb_v3.0.cytoBand.bb',
      sha256: 'f058e1b3fa6d15b5a73a0daaabf96f5fc9351849550c1221083fd059b631ccd9',
      byteLength: 38_551,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/016/772/045/GCF_016772045.2/GCF_016772045.2.agp.gz',
      sha256: '6d5cb257a306491eccaf7cf694e19ca7034e9721b833f38ad1b1e5d5ae063ad4',
      byteLength: 2_116,
    },
  }),
  genericEntry('equCabTbT2t', 'GCF_041296265.1', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/041/296/265/GCF_041296265.1/bbi/GCF_041296265.1_TB-T2T.cytoBand.bb',
      sha256: '513e588540541a2172485ab5ee92a72e780f2923a1a5584beee7d81223f32659',
      byteLength: 120_810,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/041/296/265/GCF_041296265.1/GCF_041296265.1.agp.gz',
      sha256: '7eee2da026d04383a1706b37efe8c6d05595310c2d1c95829d12e40eb126c50c',
      byteLength: 7_539,
    },
  }),
  genericEntry('danRer11', 'GCF_000002035.6', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/002/035/GCF_000002035.6/bbi/GCF_000002035.6_GRCz11.cytoBand.bb',
      sha256: '8c042e5bc46dac6731a9c3d870585cc0dd68c51bc91dd7a7d8b87dc669009670',
      byteLength: 308_733,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/002/035/GCF_000002035.6/GCF_000002035.6.agp.gz',
      sha256: 'e72c44063b22f70209becc45d60b5c1a7c041435858035d7535bef35cd3fe97f',
      byteLength: 793_199,
    },
  }),
  genericEntry('grcg7b', 'GCF_016699485.2', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/016/699/485/GCF_016699485.2/bbi/GCF_016699485.2_bGalGal1.mat.broiler.GRCg7b.cytoBand.bb',
      sha256: '1a77f395d9f04a2ad7aed817f2422df2bd70066221ab0f3b0506345f06ef532a',
      byteLength: 53_483,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/016/699/485/GCF_016699485.2/GCF_016699485.2.agp.gz',
      sha256: 'ac879e3e8a8eabb29d33e606d07cfc81ef36b1c59291f44b22b807c824f71129',
      byteLength: 16_132,
    },
  }),
  genericEntry('canFam4', 'GCF_011100685.1', {
    ucsc: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/011/100/685/GCF_011100685.1/bbi/GCF_011100685.1_UU_Cfam_GSD_1.0.cytoBand.bb',
      sha256: '71c67a67bc09b44c4f0fcbf091889439b1a02c702514d1c23f530149668b92c0',
      byteLength: 334_579,
    },
    agp: {
      sourceUrl:
        'https://hgdownload.soe.ucsc.edu/hubs/GCF/011/100/685/GCF_011100685.1/GCF_011100685.1.agp.gz',
      sha256: 'b4fff8a138c099be0826af2ecd055df02a7b859ab8ca95ddc0b4e9ae1db659be',
      byteLength: 40_054,
    },
  }),
];

const RESOLVED_IDS = new Set([
  'grch38',
  'sacCer3',
  'ce11',
  'mm39',
  'rn8',
  'hs1',
  'grcz12tu',
  'tair10',
  'agis1',
  't2tMmu8v2',
  'rn7',
  'pombeAsm294v3',
  'xenLae10',
  'mPanTro3v21',
  'mGorGor1v21',
]);
const PARTIALLY_RESOLVED_IDS = new Set(['dm6', 'rheMac10']);

const STANDARD_DISCOVERY_CHECKS: readonly HostedReferenceSemanticDiscoveryCheckV1[] = [
  'producer-annotation',
  'ncbi-feature-table',
  'ncbi-assembly-gaps',
  'ncbi-ideogram',
  'ucsc-cytobands',
  'primary-literature',
  'organism-database',
];

function discoveryAudit(
  entry: HostedReferenceSemanticSourceCatalogBaseV1
): HostedReferenceSemanticDiscoveryAuditV1 {
  return {
    contract: 'dnaforge-semantic-discovery-audit.v1',
    assemblyAccession: entry.assemblyAccession,
    reviewedAt: '2026-09-17',
    outcome: RESOLVED_IDS.has(entry.id)
      ? 'resolved'
      : PARTIALLY_RESOLVED_IDS.has(entry.id)
        ? 'partially-resolved'
        : 'unresolved-after-audit',
    checks: STANDARD_DISCOVERY_CHECKS,
    evidenceIds: entry.evidence.map(({ id }) => id),
  };
}

export const HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1: readonly HostedReferenceSemanticSourceCatalogEntryV1[] =
  Object.freeze(
    [...SPECIALIZED, ...GENERIC].map((entry) => ({
      ...entry,
      discoveryAudit: discoveryAudit(entry),
    }))
  );
