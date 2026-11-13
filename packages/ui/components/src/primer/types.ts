export interface PrimerSegment {
  sequence: string;
  width: number;
  colorType: 'homology' | 'spacer' | 'pbs' | 'cleaved' | 'overhang4bp' | 'literalExtra';
}

export interface GibsonPrimerSegments {
  type: 'gibson';
  direction: 'forward' | 'reverse';
  homology: PrimerSegment | null;
  spacer: PrimerSegment | null;
  pbs: PrimerSegment;
  totalWidth: number;
}

export interface GoldenGatePrimerSegments {
  type: 'goldengate';
  direction: 'forward' | 'reverse';
  cleaved: {
    padding5prime: PrimerSegment;
    enzymeSite: PrimerSegment;
    spacer: PrimerSegment;
    totalWidth: number;
  };
  overhang: {
    overhang4bp: PrimerSegment;
    literalExtra: PrimerSegment | null;
    totalWidth: number;
  };
  pbs: PrimerSegment;
  topCutX: number;
  bottomCutX: number;
  totalWidth: number;
  alignOffset: number;
}

export type PrimerVisualizationSegments = GibsonPrimerSegments | GoldenGatePrimerSegments;

export interface PrimerColors {
  pbs: { hex: string; text: string };
  overhang: { hex: string; text: string };
}
