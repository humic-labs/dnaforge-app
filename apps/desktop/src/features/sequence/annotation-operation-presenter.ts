import type { OperationSnapshot } from '@waypoint/api-client';
import type {
  ManagedOperationPresenter,
  ManagedOperationPresenterRegistry,
  ManagedOperationReviewProjection,
} from '../../shared/managed-operation-presenters';
import {
  canOpenAnnotationOperationResult,
  openAnnotationOperationResult,
} from './annotation-operation-review';

interface AnnotationOperationPresenterOptions {
  readonly reviewByOperationId?: Readonly<Record<string, ManagedOperationReviewProjection>>;
  readonly canOpenResult?: (operation: OperationSnapshot) => boolean;
  readonly openResult?: (operation: OperationSnapshot) => Promise<void>;
  readonly targetLabel?: (operation: OperationSnapshot) => string | undefined;
}

export function createAnnotationOperationPresenter(
  options: AnnotationOperationPresenterOptions = {}
): ManagedOperationPresenter {
  return {
    title: () => 'Annotate sequence',
    targetLabel: (operation) => options.targetLabel?.(operation),
    review: (operation) => {
      const review = options.reviewByOperationId?.[operation.id];
      if (review) return review;
      if (operation.state === 'succeeded' && operation.result_status !== 'none') {
        return {
          state: 'not-checked',
          reason: 'Review status is not recorded for this result.',
        };
      }
      return { state: 'not-required' };
    },
    canOpenResult: options.canOpenResult ?? canOpenAnnotationOperationResult,
    openResult: options.openResult ?? openAnnotationOperationResult,
  };
}

export function annotationOperationPresenters(
  options: AnnotationOperationPresenterOptions = {}
): ManagedOperationPresenterRegistry {
  return { annotation: createAnnotationOperationPresenter(options) };
}
