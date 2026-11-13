import type { AssemblyScaffold } from '@waypoint/sequence-utils';

export interface BackboneSegment {
  start: number;
  end: number;
  color: string;
  label?: string;
  strokeWidth?: number;
  rulerStrokeWidth?: number;
  alpha?: number;
  themeStableColor?: boolean;
  labelPosition?: number;
  regionId?: string;
  scaffold?: AssemblyScaffold;
}

export interface BackboneBoundaryHandleRange {
  regionId: string;
  start: number;
  end: number;
  editableSides: ReadonlyArray<'upstream' | 'downstream'>;
}
