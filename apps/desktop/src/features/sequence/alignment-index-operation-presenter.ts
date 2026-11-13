import type {
  ManagedOperationPresenter,
  ManagedOperationPresenterRegistry,
} from '../../shared/managed-operation-presenters';

export function createAlignmentIndexOperationPresenter(): ManagedOperationPresenter {
  return {
    title: () => 'Prepare alignment index',
    targetLabel: () => undefined,
    review: () => ({ state: 'not-required' }),
    canOpenResult: () => false,
    openResult: null,
  };
}

export function alignmentIndexOperationPresenters(): ManagedOperationPresenterRegistry {
  return {
    'alignment-index-preparation': createAlignmentIndexOperationPresenter(),
  };
}
