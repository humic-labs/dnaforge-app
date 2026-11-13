import type {
  ManagedOperationPresenter,
  ManagedOperationPresenterRegistry,
} from '../../shared/managed-operation-presenters';

export function createGenomeIndexOperationPresenter(): ManagedOperationPresenter {
  return {
    title: () => 'Index genome',
    targetLabel: () => undefined,
    review: () => ({ state: 'not-required' }),
    canOpenResult: () => false,
    openResult: null,
  };
}

export function genomeIndexOperationPresenters(): ManagedOperationPresenterRegistry {
  return { 'genome-indexing': createGenomeIndexOperationPresenter() };
}
