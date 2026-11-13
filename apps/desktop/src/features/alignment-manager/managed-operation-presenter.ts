import type {
  ManagedOperationPresenter,
  ManagedOperationPresenterRegistry,
} from '../../shared/managed-operation-presenters';

export function createMultipleSequenceAlignmentOperationPresenter(): ManagedOperationPresenter {
  return {
    title: () => 'Multiple sequence alignment',
    targetLabel: () => undefined,
    review: () => ({ state: 'not-required' }),
    canOpenResult: () => false,
    openResult: null,
  };
}

export function createPairwiseSessionAlignmentOperationPresenter(): ManagedOperationPresenter {
  return {
    title: () => 'Align verification session',
    targetLabel: () => undefined,
    review: () => ({ state: 'not-required' }),
    canOpenResult: () => false,
    openResult: null,
  };
}

export function alignmentOperationPresenters(): ManagedOperationPresenterRegistry {
  return {
    'multiple-sequence-alignment': createMultipleSequenceAlignmentOperationPresenter(),
    'pairwise-session-alignment': createPairwiseSessionAlignmentOperationPresenter(),
  };
}
