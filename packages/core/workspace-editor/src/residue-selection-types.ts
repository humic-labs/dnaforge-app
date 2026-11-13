export interface ResidueSelectionSource {
  kind: string;
  id?: string;
  surface?: string;
  label?: string;
}

export interface ResidueSelectionStructureTarget {
  structureId: string;
  chain: string;
  position: number;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  labelSeqId?: number;
  operator?: string;
}

export interface ResidueInterval {
  start: number;
  end: number;
}

export type ResidueMoleculeKind = 'protein' | 'translated-cds' | 'protein-msa-row' | string;

export interface ResidueSelectionTarget {
  moleculeId: string;
  moleculeKind: ResidueMoleculeKind;
  coordinateSystem: 'residue';
  intervals: ReadonlyArray<ResidueInterval>;
  label?: string;
}

export interface ResidueSelectionCodingDnaInterval {
  start: number;
  end: number;
}

export interface ResidueSelectionCodingDnaMapping {
  kind: 'coding-dna';
  referenceId: string;
  featureId?: string;
  strand: 1 | -1;
  intervals: ReadonlyArray<ResidueSelectionCodingDnaInterval>;
}

export interface ResidueSelectionStructureMapping extends ResidueSelectionStructureTarget {
  kind: 'structure';
  residueStart: number;
  residueEnd: number;
}

export interface ResidueSelectionProteinMsaMapping {
  kind: 'protein-msa';
  alignmentId: string;
  rowId: string;
  intervals: ReadonlyArray<ResidueInterval>;
}

export type ResidueSelectionMapping =
  | ResidueSelectionCodingDnaMapping
  | ResidueSelectionStructureMapping
  | ResidueSelectionProteinMsaMapping;

export interface ResidueSelection {
  selectionId?: string;
  source?: ResidueSelectionSource;
  target: ResidueSelectionTarget;
  mappings?: ReadonlyArray<ResidueSelectionMapping>;
}
