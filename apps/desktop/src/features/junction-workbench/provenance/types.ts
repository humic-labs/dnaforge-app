import type { Annotation, ColoredCutSite } from '@waypoint/sequence-utils';
import type { DesignAnnotation, DesignRegion, SequenceDesign } from '../../design/public/types';
import type { CoordMappingPoint } from '../coord-mapping';
import type { SourceContextStatus, SourceContextWindow, SourceRef } from '../SourceContextRegistry';
import type {
  BioCol,
  ProductInterval,
  ProductPosition,
  RowPosition,
  SourceBaseIndex,
  UnwrappedSourceBase,
  UnwrappedSourceBoundary,
  UnwrappedSourceInterval,
} from './coordinates';

export type ProvenanceAssemblyMethod = Extract<
  SequenceDesign['assemblyMethod'],
  'gibson' | 'nebuilder' | 'goldengate'
>;

export interface ProjectSourceProvenanceInput {
  rowId: string;
  side: 'left' | 'right';
  region: DesignRegion;
  rawRegion?: DesignRegion;
  assemblyMethod: ProvenanceAssemblyMethod;
  registeredStartBioCol: number;
  registeredEndBioCol: number;
  productJunctionPosition: number;
  spacerLength: number;
  bufferLeft?: number;
  bufferRight?: number;
  sourceWindow?: SourceContextWindow;
}

export interface DigestBoundaryProjection {
  id: string;
  enzymeName: string;
  sourceEnd: 'upstream' | 'downstream';
  recognitionInterval: UnwrappedSourceInterval;
  topCutBoundary: UnwrappedSourceBoundary;
  bottomCutBoundary: UnwrappedSourceBoundary;
  overhang: {
    kind: 'blunt' | '5prime' | '3prime';
    length: number;
    interval: UnwrappedSourceInterval | null;
  };
  retainedScarInterval: UnwrappedSourceInterval | null;
  participatesInContribution: boolean;
}

export interface SourceBaseProjection {
  rowPosition: RowPosition;
  bioCol: BioCol;
  sourceBase: UnwrappedSourceBase | null;
  normalizedSourceBase: SourceBaseIndex | null;
  productPosition: ProductPosition | null;
  owner: 'contributing' | 'muted' | 'unavailable';
  provenanceId: string | null;
  base: string;
}

export interface ValidatedSourceProvenanceProjection {
  rowId: string;
  side: 'left' | 'right';
  regionId: string;
  sourceRef: SourceRef;
  sourceLength: number;
  circular: boolean;
  sourceStatus: SourceContextStatus | 'clipped-fallback';
  intervals: {
    physicalSourceInterval: UnwrappedSourceInterval;
    assembledContributionIntervals: UnwrappedSourceInterval[];
    visibleContextInterval: UnwrappedSourceInterval;
    productContributionInterval: ProductInterval | null;
  };
  digestBoundaries: DigestBoundaryProjection[];
  scarAnnotations: DesignAnnotation[];
  bases: SourceBaseProjection[];
  validation: {
    valid: true;
    schemaVersion: 1;
    inputHash: string;
  };
}

export interface ProductBaseProjection {
  productPosition: ProductPosition;
  bioCol: BioCol;
  owner: 'left' | 'right' | 'spacer';
  sourceRegionId: string | null;
  sourceBase: UnwrappedSourceBase | null;
  provenanceId: string;
}

export interface ProductContributionSegment {
  owner: 'left' | 'right' | 'spacer';
  startRowPosition: number;
  endRowPosition: number;
}

export interface ProductProvenanceProjection {
  bases: ProductBaseProjection[];
  segments: ProductContributionSegment[];
}

export interface DerivedSourceRowFields {
  sequence: string;
  coordinateStart: number;
  points: CoordMappingPoint[];
  sourceByRowPosition: Array<number | null>;
  visibleColumns: number[];
  contributingColumns: number[];
  mutedColumns: number[];
  mutedColumnSet: Set<number>;
  cutSites: ColoredCutSite[];
  annotations?: Annotation[];
}
