import { molecularCatalogContract } from '../../shared/ipc/molecular-catalog.contract';
import { handleGroup } from '../../shared/ipc-contract';
import type {
  MolecularCatalogListInput,
  MolecularCatalogRegisterInput,
} from '../../shared/molecular-catalog';
import type { MolecularCatalogService } from './service';

export function registerMolecularCatalogHandlers(catalog: MolecularCatalogService): void {
  handleGroup(molecularCatalogContract, {
    register: (_event, input: MolecularCatalogRegisterInput) => catalog.register(input),
    list: (_event, input: MolecularCatalogListInput) => catalog.list(input),
    load: (_event, observationId: string) => {
      if (typeof observationId !== 'string' || !/^[a-f0-9]{64}$/.test(observationId))
        throw new Error('Invalid structure observation ID.');
      return catalog.load(observationId);
    },
  });
}
