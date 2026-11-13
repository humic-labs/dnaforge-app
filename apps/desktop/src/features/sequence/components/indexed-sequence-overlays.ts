import type { CutSite, Primer } from '@waypoint/genome-renderer';

export interface IndexedSequenceOverlays {
  readonly cutSites: CutSite[];
  readonly primers: readonly Primer[];
}

const NO_CUT_SITES: CutSite[] = [];
const NO_PRIMERS: readonly Primer[] = [];

export const EMPTY_INDEXED_SEQUENCE_OVERLAYS: IndexedSequenceOverlays = {
  cutSites: NO_CUT_SITES,
  primers: NO_PRIMERS,
};
