import type {
  ManagedOperationPresenter,
  ManagedOperationPresenterRegistry,
} from '../../shared/managed-operation-presenters';

export function createAlignmentCoverageOperationPresenter(): ManagedOperationPresenter {
  return {
    title: () => 'Prepare alignment coverage',
    targetLabel: () => undefined,
    review: () => ({ state: 'not-required' }),
    canOpenResult: () => false,
    openResult: null,
  };
}

export function alignmentCoverageOperationPresenters(): ManagedOperationPresenterRegistry {
  return {
    'alignment-coverage-preparation': createAlignmentCoverageOperationPresenter(),
  };
}
