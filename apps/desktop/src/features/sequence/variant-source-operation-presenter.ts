import type {
  ManagedOperationPresenter,
  ManagedOperationPresenterRegistry,
} from '../../shared/managed-operation-presenters';

export function createVariantSourceOperationPresenter(): ManagedOperationPresenter {
  return {
    title: () => 'Prepare variant source',
    targetLabel: () => undefined,
    review: () => ({ state: 'not-required' }),
    canOpenResult: () => false,
    openResult: null,
  };
}

export function variantSourceOperationPresenters(): ManagedOperationPresenterRegistry {
  return {
    'variant-source-preparation': createVariantSourceOperationPresenter(),
  };
}
