import { defineGroup, invoke } from './contract';

export const molecularCatalogContract = defineGroup('molecularCatalog', {
  register: invoke<
    [input: import('../molecular-catalog').MolecularCatalogRegisterInput],
    import('../molecular-catalog').MolecularCatalogMatch
  >(),
  list: invoke<
    [input: import('../molecular-catalog').MolecularCatalogListInput],
    import('../molecular-catalog').MolecularCatalogMatch[]
  >(),
  load: invoke<[observationId: string], import('../molecular-catalog').MolecularCatalogLoaded>(),
});
