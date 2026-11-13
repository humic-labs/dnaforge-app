import type {
  InlineReferenceDeclaration,
  InlineReferenceFailureCode,
} from '../../../../shared/inline-reference-declaration';
export { INLINE_REFERENCE_ENTITY_TYPES } from '../../../../shared/inline-reference-declaration';
export type {
  InlineReferenceDeclaration,
  InlineReferenceEntityType,
  InlineReferenceFailureCode,
} from '../../../../shared/inline-reference-declaration';
export type InlineReferenceState =
  | { status: 'pending' }
  | { status: 'suppressed-duplicate'; canonicalLabel: string }
  | {
      status: 'resolved';
      canonicalLabel: string;
      referenceId?: string;
      reference?: import('../../../../db/entity-references').DBEntityReference;

      targetType?: InlineReferenceTargetType;
    }
  | { status: 'invalid'; code: InlineReferenceFailureCode | string };

export interface InlineReferencePart {
  key: string;
  label: string;
  sourceRange: {
    start: number;
    end: number;
  };
  declaration: InlineReferenceDeclaration;
  state: InlineReferenceState;
}

export interface InlineTextDocument {
  source: string;
  renderSource: string;
  parts: InlineReferencePart[];
}
import type { InlineReferenceTargetType } from '../../../../shared/inline-reference-ipc';
