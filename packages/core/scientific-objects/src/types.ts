import type { WorkTaskDocument } from './work-task-types';
import type {
  BlobHash,
  CanonicalMap,
  CanonicalValue,
  ResourceId,
  ResourceRevisionId,
} from '@waypoint/workspace-revisions';

export interface ScientificFileRepresentation {
  readonly format: string;
  readonly text: string;
}

export interface RevisionPin {
  readonly resourceId: ResourceId;
  readonly revisionId: ResourceRevisionId;
}

interface NamedDocument {
  readonly formatVersion: 1;
  readonly name: string;

  readonly fields: CanonicalMap;
}

export interface OligoModification {
  readonly anchor:
    | { readonly kind: 'terminus'; readonly end: 'five-prime' | 'three-prime' }
    | { readonly kind: 'between-bases'; readonly offset: number }
    | { readonly kind: 'base'; readonly index: number };
  readonly code: string;
  readonly details: CanonicalMap;
}

export interface PrimerDocument extends NamedDocument {
  readonly kind: 'primer';
  readonly molecule: 'DNA' | 'RNA';
  readonly bases: string;
  readonly modifications: readonly OligoModification[];
}

export interface SequenceDocument extends NamedDocument {
  readonly kind: 'sequence';
  readonly molecule: 'DNA' | 'RNA';
  readonly bases: string;
  readonly topology: 'linear' | 'circular';
  readonly annotations: readonly CanonicalValue[];
}

export interface StrainDocument extends NamedDocument {
  readonly kind: 'strain';
  readonly taxon: string | null;
}

export interface PrimerBindingDocument {
  readonly formatVersion: 1;
  readonly kind: 'primer-binding';
  readonly primerId: ResourceId;

  readonly target: RevisionPin;
  readonly coordinates: {
    readonly start: number;
    readonly end: number;
    readonly strand: 1 | -1;
  };
}

export interface BindingEvidenceDocument {
  readonly formatVersion: 1;
  readonly kind: 'binding-evidence';
  readonly binding: RevisionPin;
  readonly primer: RevisionPin;
  readonly target: RevisionPin;
  readonly algorithm: {
    readonly name: string;
    readonly version: string;
    readonly parameters: CanonicalMap;
  };
  readonly outcome: 'valid' | 'invalid';
  readonly result: CanonicalMap;
}

export interface StrainSequenceDocument {
  readonly formatVersion: 1;
  readonly kind: 'strain-sequence';
  readonly strainId: ResourceId;
  readonly sequence: RevisionPin;
  readonly assertion: 'planned' | 'observed';
  readonly evidence: readonly RevisionPin[];

  readonly fields?: CanonicalMap;
}

export interface StrainDescentDocument {
  readonly formatVersion: 1;
  readonly kind: 'strain-descent';
  readonly strainId: ResourceId;
  readonly parent: RevisionPin;
  readonly assertion: 'planned' | 'observed';
  readonly evidence: readonly RevisionPin[];
  readonly fields?: CanonicalMap;
}

export interface AcceptedAssemblyDocument {
  readonly formatVersion: 1;
  readonly kind: 'accepted-assembly';
  readonly constructId: ResourceId;
  readonly parent: RevisionPin | null;
  readonly sources: readonly RevisionPin[];
  readonly primers: readonly RevisionPin[];
  readonly product: RevisionPin;

  readonly recipe: CanonicalMap;
}

export type ScientificDocument =
  | PrimerDocument
  | SequenceDocument
  | StrainDocument
  | PrimerBindingDocument
  | BindingEvidenceDocument
  | StrainSequenceDocument
  | StrainDescentDocument
  | AcceptedAssemblyDocument
  | WorkTaskDocument;

export interface ScientificSnapshot extends RevisionPin {
  readonly document: ScientificDocument;
  readonly scientificHash: BlobHash;

  readonly bindingInputHash: BlobHash | null;

  readonly representation?: ScientificFileRepresentation;
}

export interface ScientificReader {
  readonly current: (resourceId: ResourceId) => ScientificSnapshot | null;
  readonly revision: (pin: RevisionPin) => ScientificSnapshot | null;
  readonly hasRevision: (pin: RevisionPin) => boolean;
  readonly listCurrent: () => readonly ScientificSnapshot[];
}

export interface ScientificIssue {
  readonly code:
    | 'INVALID_DOCUMENT'
    | 'MISSING_REFERENCE'
    | 'WRONG_REFERENCE_KIND'
    | 'REFERENCE_IDENTITY_MISMATCH'
    | 'INVALID_COORDINATES'
    | 'EVIDENCE_INPUT_MISMATCH'
    | 'ASSEMBLY_HISTORY_IMMUTABLE'
    | 'KIND_IMMUTABLE'
    | 'STRAIN_DESCENT_CYCLE';
  readonly message: string;
  readonly resourceId?: ResourceId;
}

export type BindingEvidenceFreshness = 'current' | 'stale' | 'unavailable';
