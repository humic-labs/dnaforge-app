import type { ComposeIndexedTrackViewInput } from '../../features/ai/tools/compose-indexed-track-view';
import type { AppScenario } from './types';

export const POWNALL_FIGURE_4N_PRESET_ID = 'pownall-2023-figure-4n-klf17';
export const POWNALL_FIGURE_4N_REFERENCE_ID = 'danRer11';
export const POWNALL_FIGURE_4N_CONVERSATION_ID = 'pownall-figure-4n-agent-showcase';
export const POWNALL_FIGURE_4N_CHAT_LABEL = 'Figure 4N agent demo';
export const POWNALL_FIGURE_4N_USER_MESSAGE =
  'Open my saved GRCz11 Track View for Pownall 2023 Figure 4N at chr2:33,322,000–33,332,000. It should restore all four complete quantitative tracks, their labels, colors, order, heights, and absolute linear ranges.';
export const POWNALL_FIGURE_4N_ASSISTANT_MESSAGE = `Opened the saved Track View at the requested GRCz11 locus with all four complete quantitative signal tracks loaded:

- Pan-Pol II — WT 4 hpf
- Pol II pSer5 — WT 4 hpf
- Pol II pSer5 — α-amanitin 4 hpf
- Nanog — WT 3.5 hpf

Each lane is backed by the complete published BigWig, not a cropped or generated signal. The saved view restored its requested color, 96 px height, linear transform, and fixed absolute range. You can expand any track's gutter settings to change its color, height, scale mode, transform, or visible range, and I can make the same changes programmatically.`;

const DANRER11_PRIMARY_CHROMOSOMES = [
  ['chr1', '1', 59_578_282],
  ['chr2', '2', 59_640_629],
  ['chr3', '3', 62_628_489],
  ['chr4', '4', 78_093_715],
  ['chr5', '5', 72_500_376],
  ['chr6', '6', 60_270_059],
  ['chr7', '7', 74_282_399],
  ['chr8', '8', 54_304_671],
  ['chr9', '9', 56_459_846],
  ['chr10', '10', 45_420_867],
  ['chr11', '11', 45_484_837],
  ['chr12', '12', 49_182_954],
  ['chr13', '13', 52_186_027],
  ['chr14', '14', 52_660_232],
  ['chr15', '15', 48_040_578],
  ['chr16', '16', 55_266_484],
  ['chr17', '17', 53_461_100],
  ['chr18', '18', 51_023_478],
  ['chr19', '19', 48_449_771],
  ['chr20', '20', 55_201_332],
  ['chr21', '21', 45_934_066],
  ['chr22', '22', 39_133_080],
  ['chr23', '23', 46_223_584],
  ['chr24', '24', 42_172_926],
  ['chr25', '25', 37_502_051],
  ['chrM', 'MT', 16_596],
] as const;

export const POWNALL_FIGURE_4N_ANNOTATION_TRACK_TYPES = [
  'C_gene_segment',
  'D_loop',
  'RNase_P_RNA',
  'V_gene_segment',
  'antisense_RNA',
  'cDNA_match',
  'genomic DNA',
  'lnc_RNA',
  'mRNA',
  'match',
  'miRNA',
  'ncRNA',
  'origin_of_replication',
  'primary_transcript',
  'pseudogene',
  'rRNA',
  'snRNA',
  'snoRNA',
  'tRNA',
  'transcript',
] as const;

export const POWNALL_FIGURE_4N_REFERENCE_SHELL = {
  id: POWNALL_FIGURE_4N_REFERENCE_ID,
  name: 'GRCz11 (zebrafish)',
  organism: 'Danio rerio',
  taxId: 7_955,
  assembly: 'GRCz11',
  annotationTrackTypes: POWNALL_FIGURE_4N_ANNOTATION_TRACK_TYPES,
  contigs: DANRER11_PRIMARY_CHROMOSOMES.map(([chrom, displayName, lengthBp]) => ({
    chrom,
    displayName,
    lengthBp,
    circular: chrom === 'chrM',
  })),
} as const;

export function pownallFigure4NShowcaseScenario(): AppScenario {
  return {
    canvas: {
      tabs: [
        {
          type: 'chat',
          entityId: POWNALL_FIGURE_4N_CONVERSATION_ID,
          label: POWNALL_FIGURE_4N_CHAT_LABEL,
        },
      ],
      activeTabIndex: 0,
    },
    chat: {
      conversationId: POWNALL_FIGURE_4N_CONVERSATION_ID,
      messages: [
        {
          id: 'pownall-figure-4n-user',
          role: 'user',
          content: POWNALL_FIGURE_4N_USER_MESSAGE,
          createdAt: 1,
        },
        {
          id: 'pownall-figure-4n-assistant',
          role: 'assistant',
          content: POWNALL_FIGURE_4N_ASSISTANT_MESSAGE,
          createdAt: 2,
        },
      ],
    },
  };
}

export const POWNALL_FIGURE_4N_COMPOSITION = {
  name: 'Pownall 2023 — Figure 4N recreation',
  preserveCurrentTracks: false,
  viewport: { chrom: 'chr2', start0: 33_322_000, end0: 33_332_000 },
  tracks: [
    {
      kind: 'bigwig-url',
      url: 'https://track.giraldezlab.org/miao_et_al_2022_molecular_cell_ChIP-seq/danRer11/AGS001841.bw',
      settings: {
        label: 'Pan-Pol II — WT 4 hpf',
        color: '#8b5cf6',
        heightPx: 96,
        quantitative: {
          mode: 'fixed',
          transform: 'linear',
          min: 0,
          max: 11.7,
          showRange: true,
        },
      },
    },
    {
      kind: 'bigwig-url',
      url: 'https://track.giraldezlab.org/pownall_et_al_2023_science_ChIP-seq/danRer11/AGS002438.bw',
      settings: {
        label: 'Pol II pSer5 — WT 4 hpf',
        color: '#d97706',
        heightPx: 96,
        quantitative: {
          mode: 'fixed',
          transform: 'linear',
          min: 0,
          max: 15.2,
          showRange: true,
        },
      },
    },
    {
      kind: 'bigwig-url',
      url: 'https://track.giraldezlab.org/pownall_et_al_2023_science_ChIP-seq/danRer11/AGS002440.bw',
      settings: {
        label: 'Pol II pSer5 — α-amanitin 4 hpf',
        color: '#f59e0b',
        heightPx: 96,
        quantitative: {
          mode: 'fixed',
          transform: 'linear',
          min: 0,
          max: 15.2,
          showRange: true,
        },
      },
    },
    {
      kind: 'bigwig-url',
      url: 'https://track.giraldezlab.org/miao_et_al_2022_molecular_cell_ChIP-seq/danRer11/SIS000084.bw',
      settings: {
        label: 'Nanog — WT 3.5 hpf',
        color: '#0ea5e9',
        heightPx: 96,
        quantitative: {
          mode: 'fixed',
          transform: 'linear',
          min: 0,
          max: 5.43,
          showRange: true,
        },
      },
    },
  ],
} as const satisfies ComposeIndexedTrackViewInput;

export { INTERNAL_TRACK_FIXTURES as POWNALL_FIGURE_4N_LOCAL_SOURCES } from '../../shared/internal-track-fixtures';
