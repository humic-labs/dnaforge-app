import type { RevisionGraphData } from './graph';
import type { CanonicalJson } from './identity';
import type { ImmutableRecordKind } from './types';

export interface OpaqueCanonicalRecord {
  readonly kind: ImmutableRecordKind;
  readonly id: string;
  readonly canonicalJson: string;
}

export interface CanonicalRef {
  readonly name: string;
  readonly head: string | null;
}

export interface CanonicalGraphBundle {
  readonly formatVersion: 1;
  readonly workspaceId: string;
  readonly refs: readonly CanonicalRef[];
  readonly records: readonly OpaqueCanonicalRecord[];
}

export interface DecodedCanonicalRecord {
  readonly kind: ImmutableRecordKind;
  readonly id: string;
  readonly canonicalJson: CanonicalJson;
  readonly body: Readonly<Record<string, unknown>>;
}

export type CanonicalRecordError =
  | { readonly kind: 'invalid-record-envelope' }
  | { readonly kind: 'record-too-large'; readonly recordKind: ImmutableRecordKind }
  | { readonly kind: 'invalid-canonical-json'; readonly recordKind: ImmutableRecordKind }
  | {
      readonly kind: 'unsupported-future-format';
      readonly recordKind: ImmutableRecordKind;
      readonly version: number;
    }
  | { readonly kind: 'invalid-record-body'; readonly recordKind: ImmutableRecordKind }
  | {
      readonly kind: 'immutable-record-mismatch';
      readonly recordKind: ImmutableRecordKind;
      readonly id: string;
    };

export type CanonicalImportError =
  | CanonicalRecordError
  | { readonly kind: 'invalid-bundle' }
  | { readonly kind: 'immutable-record-corruption'; readonly id: string }
  | {
      readonly kind: 'missing-resource-state';
      readonly revisionId: string;
      readonly stateHash: string;
    }
  | {
      readonly kind: 'missing-resource-parent';
      readonly revisionId: string;
      readonly parentId: string;
    }
  | {
      readonly kind: 'cross-resource-parent';
      readonly revisionId: string;
      readonly parentId: string;
    }
  | { readonly kind: 'resource-parent-cycle'; readonly revisionId: string }
  | {
      readonly kind: 'missing-workspace-parent';
      readonly versionId: string;
      readonly parentId: string;
    }
  | { readonly kind: 'workspace-parent-cycle'; readonly versionId: string }
  | {
      readonly kind: 'incomplete-workspace-slot';
      readonly versionId: string;
      readonly revisionId: string;
    }
  | { readonly kind: 'workspace-id-mismatch'; readonly versionId: string }
  | { readonly kind: 'invalid-materialized-tree'; readonly versionId: string }
  | {
      readonly kind: 'duplicate-resource-root';
      readonly resourceId: string;
      readonly revisionIds: readonly [string, string];
    }
  | { readonly kind: 'invalid-workspace-transition'; readonly versionId: string }
  | { readonly kind: 'invalid-workspace-merge'; readonly versionId: string }
  | { readonly kind: 'duplicate-operation-receipt'; readonly operationId: string }
  | { readonly kind: 'incomplete-receipt-result'; readonly operationId: string }
  | { readonly kind: 'invalid-ref'; readonly refName: string }
  | { readonly kind: 'incomplete-accepted-ref'; readonly refName: string; readonly head: string };

export type ImmutableReplayClassification =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay' }
  | { readonly kind: 'corrupt'; readonly id: string };

export interface DecodedClosureInput {
  readonly workspaceId: string;
  readonly refs: readonly CanonicalRef[];
  readonly records: readonly DecodedCanonicalRecord[];
}

export interface ValidatedClosure {
  readonly data: RevisionGraphData;
}
