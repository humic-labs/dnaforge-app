export const INLINE_REFERENCE_ENTITY_TYPES = ['sequence', 'structure'] as const;

export type InlineReferenceEntityType = (typeof INLINE_REFERENCE_ENTITY_TYPES)[number];

export type InlineReferenceDeclaration =
  | {
      kind: 'project-resource';
      resource: import('./project-resource-reference').ProjectResourceReference;
    }
  | {
      kind: 'molecular-document';
      document: import('./molecular-document-reference').MolecularDocumentReference;
    }
  | {
      kind: 'existing-reference';
      referenceId: string;
    }
  | {
      kind: 'path-entity';
      entityType: InlineReferenceEntityType;
      root: string;
      segments: string[];
    }
  | {
      kind: 'workspace-path';
      root: string;
      segments: string[];
    };

export type InlineReferenceFailureCode =
  | 'invalid-scheme'
  | 'invalid-shape'
  | 'invalid-reference-id'
  | 'unsupported-entity-type'
  | 'empty-segment'
  | 'unsafe-segment'
  | 'invalid-encoding'
  | 'segment-too-long'
  | 'uri-too-long'
  | 'label-too-long';
