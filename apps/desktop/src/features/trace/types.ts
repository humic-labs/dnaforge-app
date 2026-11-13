import type { TraceData } from '@waypoint/sequence-utils';

export type { TraceData };

export type SamplePosition = number | null;

export interface MixedCallResult {
  dominant: 'A' | 'C' | 'G' | 'T';
  secondary: ReadonlyArray<'A' | 'C' | 'G' | 'T'>;
  iupacCode: string;
}

export interface ColumnGridMapping {
  sampleAtColumnX: (column: number, frac: number) => SamplePosition;
}
