import { type GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { ORF } from '@waypoint/sequence-utils';

export interface PackedORFResult {
  starts: Int32Array;
  ends: Int32Array;
  frames: Int8Array;
  strands: Int8Array;
  lengths: Int32Array;
}

export type ORFWorkerRequest =
  | {
      type: 'detect';
      jobId: number;
      sequence: string;
      minLength: number;
      geneticCode?: GeneticCodeSpec;
    }
  | {
      type: 'cancel';
      jobId: number;
    };

export type ORFWorkerResponse =
  | {
      type: 'done';
      jobId: number;
      orfs?: ORF[];
      packed?: PackedORFResult;
    }
  | {
      type: 'cancelled';
      jobId: number;
    }
  | {
      type: 'error';
      jobId: number;
      message: string;
    };
