import type { NucleicAcid } from '@waypoint/sequence-utils';
import { defineGroup, invoke, type ClientOf } from './contract';

export interface ConvertLooseSequenceFileRequest {
  readonly workspaceRoot: string;
  readonly sourcePath: string;
  readonly automatic?: boolean;
  readonly confirmedDnaSourceSha256?: string;
  readonly confirmedNucleicAcid?: NucleicAcid;
  readonly confirmedRecoverySourceSha256?: string;
}

export interface ConvertLooseSequenceFileResponse {
  readonly converted: boolean;
  readonly packageRoots: readonly string[];
  readonly reason: string | null;
  readonly disposition?: 'source-only' | 'owned' | 'blocked';
}

export interface InspectLooseSequenceFileRequest {
  readonly workspaceRoot: string;
  readonly sourcePath: string;
}

export type InspectLooseSequenceFileResponse =
  | { readonly state: 'not-sequence'; readonly reason: string | null }
  | { readonly state: 'convertible'; readonly reason: null }
  | {
      readonly state: 'recoverable';
      readonly reason: string;
      readonly sourceSha256: string;
      readonly replacementCount: number;
      readonly recordCount: number;
    }
  | {
      readonly state: 'needs-dna-confirmation';
      readonly reason: string;
      readonly sourceSha256: string;
      readonly canConvertToRna: boolean;
    }
  | { readonly state: 'refused'; readonly reason: string };

export const looseSequenceFilesContract = defineGroup('looseSequenceFiles', {
  inspect: invoke<[request: InspectLooseSequenceFileRequest], InspectLooseSequenceFileResponse>(),
  convert: invoke<[request: ConvertLooseSequenceFileRequest], ConvertLooseSequenceFileResponse>(),
});

export type LooseSequenceFilesPort = ClientOf<typeof looseSequenceFilesContract>;
