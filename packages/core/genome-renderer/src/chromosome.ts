import type { ChromosomeMorphologyV1, CytoBand } from '@waypoint/genome-data';

export interface Chromosome {
  id: string;
  displayName: string;
  length: number;
  cytobands: ReadonlyArray<CytoBand>;
  morphology?: ChromosomeMorphologyV1;
}
