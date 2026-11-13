import type { Mutation, MutationClassification } from '../types';

export const SIDECAR_VERSION = '1.0' as const;

export type SidecarType = 'verification';

export type VerificationStatus = 'pass' | 'fail' | 'warning' | 'error';

export interface VerificationReference {
  name: string;
  path: string;
  checksum: string;
  length?: number;
  circular?: boolean;
}

export interface VerificationResultSummary {
  status: VerificationStatus;
  identity: number;
  coverage?: number;
  mutations: VerificationMutation[];
  errorMessage?: string;
}

export interface VerificationMutation extends Mutation {
  position: number;
  type: 'substitution' | 'insertion' | 'deletion';
  ref: string;
  alt: string;
  length: number;
  classification?: MutationClassification;
  quality?: number;
}

export interface VerificationAlignment {
  algorithm: 'MAFFT' | 'Clustal' | 'Needle' | 'manual';
  alignedRef: string;
  alignedQuery: string;
  score?: number;
  gapOpen?: number;
  gapExtend?: number;
}

export interface VerificationInput {
  checksum: string;
  format: string;
  queryLength: number;
  filename?: string;
  averageQuality?: number;
}

export interface VerificationResult {
  type: SidecarType;
  version: typeof SIDECAR_VERSION;
  createdAt: string;
  reference: VerificationReference;
  result: VerificationResultSummary;
  alignment: VerificationAlignment;
  input: VerificationInput;
  notes?: string;
}

export interface VerificationOptions {
  reference: {
    name: string;
    path: string;
    sequence: string;
    circular?: boolean;
  };
  algorithm?: VerificationAlignment['algorithm'];
  identityThreshold?: number;
  classifyMutations?: boolean;
}

export interface MatchCriteria {
  minIdentity: number;
  maxCandidates: number;
  preferNameMatch: boolean;
}

export interface ReferenceMatch {
  reference: {
    name: string;
    path: string;
    length: number;
  };
  confidence: number;
  matchReason: 'exact_name' | 'similar_name' | 'sequence_similarity' | 'length_match';
  estimatedIdentity?: number;
}

export interface BatchVerificationInput {
  queryPath: string;
  reference: VerificationOptions['reference'];
}

export interface BatchVerificationResult {
  queryPath: string;
  sidecarPath: string;
  result: VerificationResult;
}
