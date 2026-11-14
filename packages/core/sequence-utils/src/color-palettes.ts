export interface ColorSwatchPalette {
  readonly name: string;
  readonly colors: readonly string[];
}

export const ANNOTATION_COLOR_PALETTES: readonly ColorSwatchPalette[] = [
  {
    name: 'Classic',
    colors: [
      '#4E79A7',
      '#F28E2B',
      '#E15759',
      '#76B7B2',
      '#59A14F',
      '#EDC948',
      '#B07AA1',
      '#FF9DA7',
      '#9C755F',
      '#BAB0AC',
    ],
  },
  {
    name: 'Vivid',
    colors: [
      '#4CAF50',
      '#2196F3',
      '#FF9800',
      '#9C27B0',
      '#F44336',
      '#00BCD4',
      '#FFEB3B',
      '#795548',
      '#607D8B',
      '#E91E63',
    ],
  },
  {
    name: 'Pastel',
    colors: [
      '#8DD3C7',
      '#FFFFB3',
      '#BEBADA',
      '#FB8072',
      '#80B1D3',
      '#FDB462',
      '#B3DE69',
      '#FCCDE5',
      '#D9D9D9',
      '#BC80BD',
    ],
  },
  {
    name: 'Bold',
    colors: [
      '#E41A1C',
      '#377EB8',
      '#4DAF4A',
      '#984EA3',
      '#FF7F00',
      '#A65628',
      '#F781BF',
      '#FFFF33',
      '#999999',
      '#66C2A5',
    ],
  },
  {
    name: 'Accessible',
    colors: [
      '#000000',
      '#E69F00',
      '#56B4E9',
      '#009E73',
      '#F0E442',
      '#0072B2',
      '#D55E00',
      '#CC79A7',
      '#332288',
      '#88CCEE',
    ],
  },
  {
    name: 'Muted',
    colors: [
      '#CC6677',
      '#332288',
      '#DDCC77',
      '#117733',
      '#88CCEE',
      '#882255',
      '#44AA99',
      '#999933',
      '#AA4499',
      '#DDDDDD',
    ],
  },
];

export const DEFAULT_MANUAL_ANNOTATION_COLOR = ANNOTATION_COLOR_PALETTES[0]!.colors[0]!;

export const TRACK_COLOR_PRESETS = [
  '#3b82f6',
  '#2563eb',
  '#8b5cf6',
  '#7c3aed',
  '#d97706',
  '#f59e0b',
  '#16a34a',
  '#0891b2',
  '#e11d48',
  '#64748b',
  '#111827',
  '#f8fafc',
] as const;

export const VARIANT_CLASS_COLORS = {
  substitution: 0xdc2626,
  insertion: 0x16a34a,
  deletion: 0xea580c,
  replacement: 0x7c3aed,
  mixed: 0x2563eb,
  structural: 0x9333ea,
} as const;

export const TRACK_DEFAULT_COLORS = {
  importedData: 0x3b82f6,
  quantitativeFallback: 0x2563eb,
  peak: 0x7c3aed,
  annotationFallback: 0x3b82f6,
  pileupLight: 0xa8ceff,
  pileupDark: 0x1d4ed8,
  variant: VARIANT_CLASS_COLORS.substitution,
  userAnnotation: 0x16a34a,
} as const;
