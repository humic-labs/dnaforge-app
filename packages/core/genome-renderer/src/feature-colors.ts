import {
  contrastTextColor,
  webglAnnotationColorForMode,
  webglThemeColorToCss,
  type WebGLThemeMode,
} from './renderers/pixi/shared/theme';

export const DEFAULT_FEATURE_COLOR = 0x9ca3af;

export const FEATURE_TYPE_COLORS: Record<string, number> = {
  CDS: 0x3b82f6,
  gene: 0x3b82f6,
  promoter: 0x22c55e,
  terminator: 0xef4444,
  RBS: 0x14b8a6,
  regulatory: 0x14b8a6,
  primer_bind: 0x8b5cf6,
  rep_origin: 0xf97316,
  origin: 0xf97316,
  misc_feature: 0x6b7280,
  enhancer: 0x22c55e,
  polyA_signal: 0xef4444,
  intron: 0x9ca3af,
  exon: 0x3b82f6,
  "5'UTR": 0xa855f7,
  "3'UTR": 0xa855f7,
  mRNA: 0x3b82f6,
  ncRNA: 0x9b59b6,
  lncRNA: 0x9b59b6,
  lnc_RNA: 0x9b59b6,
  tRNA: 0x2ecc71,
  rRNA: 0x1abc9c,
  misc_recomb: 0xe67e22,
  centromere: 0xe74c3c,
};

export function featureTypeColor(type: string): number {
  return FEATURE_TYPE_COLORS[type] ?? DEFAULT_FEATURE_COLOR;
}

export const TRANSCRIPT_COLORS = {
  light: {
    utr: 0x38bdf8,
    exonThin: 0x60a5fa,
    cdsThick: 0x1d4ed8,
    intron: 0x9ca3af,
    intronChevron: 0x6b7280,
    ncRnaExon: 0xa855f7,
  },
  dark: {
    utr: 0x2c6790,
    exonThin: 0x335599,
    cdsThick: 0x2d37a9,
    intron: 0x475166,
    intronChevron: 0x566481,
    ncRnaExon: 0x7e3295,
  },
} as const;

export type TranscriptColorRole = keyof (typeof TRANSCRIPT_COLORS)['light'];

export function transcriptColorForMode(
  role: TranscriptColorRole,
  mode: WebGLThemeMode | undefined
): number {
  return (mode === 'dark' ? TRANSCRIPT_COLORS.dark : TRANSCRIPT_COLORS.light)[role];
}

export type RnaColorFamily =
  | 'messenger'
  | 'longNonCoding'
  | 'nonCoding'
  | 'micro'
  | 'smallNucleolar'
  | 'smallNuclear'
  | 'transfer'
  | 'ribosomal';

export const DARK_RNA_FAMILY_COLORS: Readonly<Record<RnaColorFamily, number>> = Object.freeze({
  messenger: 0x2d37a9,
  longNonCoding: 0x6b319b,
  nonCoding: 0x7e3295,
  micro: 0x93348b,
  smallNucleolar: 0x523399,
  smallNuclear: 0x3d3597,
  transfer: 0x30838d,
  ribosomal: 0x328675,
});

export function rnaColorFamilyForType(type: string): RnaColorFamily | null {
  const normalized = type.toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'transcript' || normalized === 'mrna') return 'messenger';
  if (normalized === 'lncrna') return 'longNonCoding';
  if (normalized === 'mirna') return 'micro';
  if (normalized === 'snorna') return 'smallNucleolar';
  if (normalized === 'snrna') return 'smallNuclear';
  if (normalized === 'trna') return 'transfer';
  if (normalized === 'rrna') return 'ribosomal';
  if (normalized.includes('rna')) return 'nonCoding';
  return null;
}

export function rnaCanonicalSourceColor(type: string): number {
  switch (rnaColorFamilyForType(type)) {
    case 'messenger':
      return featureTypeColor('mRNA');
    case 'transfer':
      return featureTypeColor('tRNA');
    case 'ribosomal':
      return featureTypeColor('rRNA');
    case 'longNonCoding':
    case 'nonCoding':
    case 'micro':
    case 'smallNucleolar':
    case 'smallNuclear':
      return featureTypeColor('ncRNA');
    default:
      return DEFAULT_FEATURE_COLOR;
  }
}

export function rnaAccentColorForMode(type: string, mode: WebGLThemeMode | undefined): number {
  const family = rnaColorFamilyForType(type);
  if (mode === 'dark' && family) return DARK_RNA_FAMILY_COLORS[family];
  return family === 'messenger'
    ? transcriptColorForMode('cdsThick', mode)
    : transcriptColorForMode('ncRnaExon', mode);
}

export function isNonCodingTranscriptType(type: string): boolean {
  const family = rnaColorFamilyForType(type);
  return family !== null && family !== 'messenger';
}

export function isTranscriptSourceType(type: string): boolean {
  return rnaColorFamilyForType(type) !== null;
}

export function annotationTypeAccentColor(type: string, mode: WebGLThemeMode | undefined): number {
  if (isTranscriptSourceType(type)) {
    return rnaAccentColorForMode(type, mode);
  }
  return webglAnnotationColorForMode(featureTypeColor(type), mode);
}

export interface AnnotationTypeBadgeStyle {
  readonly background: string;
  readonly color: string;
  readonly accent: string;
}

export function annotationTypeBadgeStyle(
  type: string,
  mode: WebGLThemeMode | undefined
): AnnotationTypeBadgeStyle {
  const background = annotationTypeAccentColor(type, mode);
  return {
    background: webglThemeColorToCss(background),
    color: webglThemeColorToCss(contrastTextColor(background)),
    accent: webglThemeColorToCss(background),
  };
}
