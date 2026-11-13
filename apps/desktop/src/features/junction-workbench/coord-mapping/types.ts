export type CoordMappingStrategyName = 'gibson' | 'nebuilder' | 'goldengate';

export type JunctionWorkbenchRowKind = 'left-source' | 'product' | 'right-source';

export type CoordMappingPointKind =
  | 'valid'
  | 'many-to-one'
  | 'generated-tail'
  | 'gap'
  | 'unavailable'
  | 'constrained-end';

export interface CoordMappingPoint {
  rowId: string;
  bioCol: number;
  rowPosition: number;
  productPosition: number | null;
  sourcePosition?: number | null;
  kind: CoordMappingPointKind;
  editable: boolean;
  label?: string;
}

interface BaseCoordMappingConstraint {
  startBioCol: number;
  endBioCol: number;
  editable: boolean;
  label: string;
}

export interface HomologyWidthCoordMappingConstraint extends BaseCoordMappingConstraint {
  kind: 'homology-width';
  spacerLength?: number;
  leftHomologyEndBioCol?: number;
  rightHomologyStartBioCol?: number;
  leftTailEndBioCol?: number;
  rightTailStartBioCol?: number;
  leftTailPresent?: boolean;
  rightTailPresent?: boolean;
  overlapStartBioCol?: number;
  overlapEndBioCol?: number;
}

export type CoordMappingConstraint =
  | HomologyWidthCoordMappingConstraint
  | (BaseCoordMappingConstraint & {
      kind: 'nebuilder-resection' | 'fixed-overhang' | 'physical-end';
    });

export interface CoordMappingRow {
  id: string;
  kind: JunctionWorkbenchRowKind;
  label: string;
  sequence: string;
  coordinateStart: number;
  anchorRowPosition: number;
  points: CoordMappingPoint[];
  constraints?: CoordMappingConstraint[];
}

export interface CoordMapping {
  strategy: CoordMappingStrategyName;
  rows: CoordMappingRow[];
  maxWindowBp: number;
}

export interface ScreenMappingResult {
  rowId: string;
  rowPosition: number;
  bioCol: number;
  productPosition: number | null;
  sourcePosition?: number | null;
  kind: CoordMappingPointKind;
  editable: boolean;
}

export interface CoordMappingStrategy {
  name: CoordMappingStrategyName;
  create(input: Omit<CoordMapping, 'strategy'>): CoordMapping;
}
