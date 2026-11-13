export const BASE_COLORS = {
  A: '#64F73F',
  T: '#FFB340',
  G: '#EBD75D',
  C: '#5D8DFF',
  '-': '#CCCCCC',
} as const;

export const NUCLEOTIDE_COLORS = {
  A: { bg: '#E8F5E9', text: '#1B5E20' },
  T: { bg: '#E3F2FD', text: '#0D47A1' },
  C: { bg: '#FFF3E0', text: '#E65100' },
  G: { bg: '#FCE4EC', text: '#880E4F' },
  N: { bg: '#EEEEEE', text: '#616161' },
  gap: { bg: '#FFFFFF', text: '#9E9E9E' },
} as const;

export const ANNOTATION_COLORS = {
  CDS: '#4CAF50',
  gene: '#2196F3',
  misc_feature: '#FF9800',
  promoter: '#9C27B0',
  terminator: '#F44336',
} as const;

export interface AnnotationColorPalette {
  id: string;
  name: string;
  colors: {
    CDS: string;
    gene: string;
    misc_feature: string;
    promoter: string;
    terminator: string;
    [key: string]: string;
  };
}

export const ANNOTATION_PALETTES: Record<string, AnnotationColorPalette> = {
  custom: {
    id: 'custom',
    name: 'Custom',
    colors: {
      CDS: '#4CAF50',
      gene: '#2196F3',
      misc_feature: '#FF9800',
      promoter: '#9C27B0',
      terminator: '#F44336',
    },
  },
  default: {
    id: 'default',
    name: 'Default',
    colors: {
      CDS: '#4CAF50',
      gene: '#2196F3',
      misc_feature: '#FF9800',
      promoter: '#9C27B0',
      terminator: '#F44336',
    },
  },
  pastel: {
    id: 'pastel',
    name: 'Pastel',
    colors: {
      CDS: '#A8D5BA',
      gene: '#A8C8E8',
      misc_feature: '#F5D5A8',
      promoter: '#D4A8E8',
      terminator: '#F5A8A8',
    },
  },
  vibrant: {
    id: 'vibrant',
    name: 'Vibrant',
    colors: {
      CDS: '#00E676',
      gene: '#2979FF',
      misc_feature: '#FF9100',
      promoter: '#D500F9',
      terminator: '#FF1744',
    },
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean',
    colors: {
      CDS: '#26A69A',
      gene: '#0288D1',
      misc_feature: '#00ACC1',
      promoter: '#5C6BC0',
      terminator: '#7E57C2',
    },
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    colors: {
      CDS: '#FF7043',
      gene: '#FFA726',
      misc_feature: '#FFCA28',
      promoter: '#EC407A',
      terminator: '#AB47BC',
    },
  },
  earth: {
    id: 'earth',
    name: 'Earth',
    colors: {
      CDS: '#8D6E63',
      gene: '#78909C',
      misc_feature: '#A1887F',
      promoter: '#90A4AE',
      terminator: '#6D4C41',
    },
  },
  neon: {
    id: 'neon',
    name: 'Neon',
    colors: {
      CDS: '#39FF14',
      gene: '#00FFFF',
      misc_feature: '#FF6600',
      promoter: '#FF00FF',
      terminator: '#FF073A',
    },
  },
} as const;

export function getAvailablePaletteIds(): string[] {
  return Object.keys(ANNOTATION_PALETTES);
}

export function getPalette(paletteId: string): AnnotationColorPalette {
  return ANNOTATION_PALETTES[paletteId] || ANNOTATION_PALETTES.default;
}

let currentPaletteId = 'default';

export function setActivePalette(paletteId: string): void {
  if (ANNOTATION_PALETTES[paletteId]) {
    currentPaletteId = paletteId;
  }
}

export function getActivePaletteId(): string {
  return currentPaletteId;
}

export const MUTATION_COLORS = {
  substitution: '#ffdd44',
  insertion: '#bb66ff',
  deletion: '#ff6666',
} as const;

export type NucleotideBase = keyof typeof BASE_COLORS;
export type AnnotationType = keyof typeof ANNOTATION_COLORS;
export type MutationType = keyof typeof MUTATION_COLORS;

export function getBaseColor(base: string): string {
  const upperBase = base.toUpperCase();
  return BASE_COLORS[upperBase as NucleotideBase] || BASE_COLORS['-'];
}

export function getNucleotideColors(base: string): { bg: string; text: string } {
  const upperBase = base.toUpperCase();
  if (upperBase in NUCLEOTIDE_COLORS) {
    return NUCLEOTIDE_COLORS[upperBase as keyof typeof NUCLEOTIDE_COLORS];
  }
  return NUCLEOTIDE_COLORS.N;
}

export function getAnnotationColor(type: string, paletteId?: string): string {
  const palette = paletteId ? getPalette(paletteId) : getPalette(currentPaletteId);
  return palette.colors[type] || palette.colors.misc_feature;
}

export const FEATURE_COLORS: Record<string, string> = {
  CDS: '#3B82F6',
  gene: '#3B82F6',
  promoter: '#22C55E',
  terminator: '#EF4444',
  rep_origin: '#F97316',
  origin: '#F97316',
  primer_bind: '#8B5CF6',
  misc_feature: '#6B7280',
  regulatory: '#14B8A6',
  RBS: '#14B8A6',
  enhancer: '#22C55E',
  polyA_signal: '#EF4444',
  sig_peptide: '#EC4899',
  transit_peptide: '#EC4899',
  intron: '#9CA3AF',
  exon: '#3B82F6',
  "5'UTR": '#A855F7',
  "3'UTR": '#A855F7',
  LTR: '#F59E0B',
  repeat_region: '#F59E0B',
  mobile_element: '#DC2626',
  mRNA: '#0EA5E9',
  tRNA: '#DB2777',
  rRNA: '#BE185D',
  ncRNA: '#9333EA',
  snoRNA: '#9333EA',
  snRNA: '#9333EA',
  misc_RNA: '#9333EA',
  telomere: '#7C3AED',
  centromere: '#CA8A04',
  default: '#9CA3AF',
};

export function getFeatureColor(type: string): string {
  return FEATURE_COLORS[type] || FEATURE_COLORS.default;
}

export interface AminoAcidColorScheme {
  id: string;
  name: string;
  description: string;
  colors: Record<string, string>;
}

export const AA_COLOR_SCHEMES: Record<string, AminoAcidColorScheme> = {
  rasmol: {
    id: 'rasmol',
    name: 'RasMol',
    description: 'Groups by chemical property (polar=bright, nonpolar=subdued)',
    colors: {
      A: '#C8C8C8',
      R: '#145AFF',
      N: '#00DCDC',
      D: '#E60A0A',
      C: '#E6E600',
      Q: '#00DCDC',
      E: '#E60A0A',
      G: '#EBEBEB',
      H: '#8282D2',
      I: '#0F820F',
      L: '#0F820F',
      K: '#145AFF',
      M: '#E6E600',
      F: '#3232AA',
      P: '#DC9682',
      S: '#FA9600',
      T: '#FA9600',
      W: '#B45AB4',
      Y: '#3232AA',
      V: '#0F820F',
      '*': '#CC0000',
    },
  },
  hydrophobicity: {
    id: 'hydrophobicity',
    name: 'Hydrophobicity',
    description: 'Red→blue spectrum: hydrophobic=red, hydrophilic=blue',
    colors: {
      I: '#FF0000',
      V: '#F00A0A',
      L: '#EA1010',
      F: '#CB2F2F',
      C: '#C23838',
      M: '#B94141',
      A: '#AD4D4D',
      G: '#6B856B',
      T: '#5E925E',
      S: '#4FA04F',
      W: '#468A46',
      Y: '#3D933D',
      P: '#339C33',
      H: '#29A629',
      D: '#1FBF1F',
      E: '#14D214',
      N: '#0AE60A',
      Q: '#00FF00',
      K: '#0000FF',
      R: '#0000FF',
      '*': '#CC0000',
    },
  },
  clustalx: {
    id: 'clustalx',
    name: 'Clustal X',
    description: 'Conservation-style coloring by property group',
    colors: {
      A: '#197FE5',
      V: '#197FE5',
      I: '#197FE5',
      L: '#197FE5',
      M: '#197FE5',
      F: '#197FE5',
      W: '#197FE5',
      K: '#E53319',
      R: '#E53319',
      D: '#CC4DE8',
      E: '#CC4DE8',
      N: '#19CC19',
      Q: '#19CC19',
      S: '#19CC19',
      T: '#19CC19',
      C: '#E8B519',
      G: '#E88419',
      P: '#CCE619',
      H: '#19B2B2',
      Y: '#19B2B2',
      '*': '#CC0000',
    },
  },
};

export function getAAScheme(id: string): AminoAcidColorScheme {
  return AA_COLOR_SCHEMES[id] || AA_COLOR_SCHEMES.rasmol;
}

export function getAAColor(aa: string, schemeId: string): string {
  const scheme = AA_COLOR_SCHEMES[schemeId];
  if (!scheme) return '#9CA3AF';
  return scheme.colors[aa] || '#9CA3AF';
}
