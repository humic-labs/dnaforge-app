import type { UserMessage } from '@waypoint/user-messages';
import type {
  AnnotationDocumentApplyResponse,
  AnnotationDocumentSelection,
} from '@waypoint/api-client';
import type { DraftAnnotation } from '../../shared/annotation-review';
export {
  CONFIDENCE_THRESHOLDS,
  type DbSource,
  type DraftAnnotation,
  type DuplicateReason,
  type DuplicateStatus,
  type PlannotateFeature,
} from '../../shared/annotation-review';

export interface AnnotationReviewState {
  isActive: boolean;
  drafts: DraftAnnotation[];
  selectedIndex: number;
}

export type DraftQualifiers = {
  source: ['pLannotate-draft'];
  status: ['accepted'] | ['rejected'];
  suppressedBy?: [string];
};

export type NativeAnnotationReviewInspection =
  | { readonly status: 'checking' }
  | {
      readonly status: 'unavailable';
      readonly reason: UserMessage;
      readonly recovery: 'refresh' | 'rerun';
    }
  | {
      readonly status: 'ready';
      readonly savedVersion: number;
      readonly selection: Omit<AnnotationDocumentSelection, 'selectedCandidateIds'>;
      readonly coordinates: 'exact' | 'mapped';
      readonly transitionCount: number;
      readonly substitutionOverlap: boolean;
    };

export type NativeAnnotationReviewResult =
  | {
      readonly status: 'saved';
      readonly actionId: string;
      readonly receipt: AnnotationDocumentApplyResponse;
    }
  | { readonly status: 'already-applied' }
  | {
      readonly status: 'previous-runtime';
      readonly reason: UserMessage;
      readonly actionId: string;
      readonly receipt: AnnotationDocumentApplyResponse;
    }
  | {
      readonly status: 'blocked' | 'save-failed' | 'outcome-unresolved';
      readonly reason: UserMessage;
      readonly actionId?: string;
      readonly receipt?: AnnotationDocumentApplyResponse;
    };
