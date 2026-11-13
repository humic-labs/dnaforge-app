import { type CodingSequence } from '@waypoint/sequence-utils';

export interface IntronInfo {
  number: number;
  genomicStart: number;
  genomicEnd: number;
  length: number;
  phase: number;
  donorSite: string;
  acceptorSite: string;
  codingSeqBoundary: number;
}

export interface SplicedCodingSequence extends CodingSequence {
  introns: IntronInfo[];
}
