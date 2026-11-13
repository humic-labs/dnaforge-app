import type {
  ProviderObjectClass,
  ProviderObjectReference,
  ProviderReferenceResolution,
} from '../../../../shared/provider-object-reference';

export type BenchlingReferenceAttrs = {
  refId: string;
  sourceNotebookId: string;
  relationshipId: string;
  relationType: string;
  target: ProviderObjectReference;
  expectedObjectClass: ProviderObjectClass;
  label: string;
  sourceUrl: string | null;
  disposition: 'pending' | 'external' | 'source_broken';
  brokenReason?: string | null;
};

export type BenchlingReferenceCardState =
  | { kind: 'loading' }
  | { kind: 'resolved'; title: string; entityType: string; entityId: string; scope: string }
  | { kind: 'pending'; reason: 'target_not_imported' | 'identity_missing' }
  | { kind: 'ambiguous' }
  | { kind: 'external'; sourceUrl: string }
  | { kind: 'source_broken'; reason: string }
  | { kind: 'unavailable'; message: string };

export function cardStateFromResolution(
  resolution: ProviderReferenceResolution,
  target: { entityId: string; title: string; entityType: string; scope: string } | null
): BenchlingReferenceCardState {
  switch (resolution.status) {
    case 'resolved':
      return target
        ? {
            kind: 'resolved',
            title: target.title,
            entityType: target.entityType,
            entityId: target.entityId,
            scope: target.scope,
          }
        : { kind: 'pending', reason: 'target_not_imported' };
    case 'pending':
      return { kind: 'pending', reason: resolution.reason };
    case 'ambiguous':
      return { kind: 'ambiguous' };
    case 'external':
      return { kind: 'external', sourceUrl: resolution.sourceUrl };
    case 'source_broken':
      return { kind: 'source_broken', reason: resolution.reason };
  }
}
