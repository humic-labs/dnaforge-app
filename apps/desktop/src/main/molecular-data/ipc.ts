import { handleGroup } from '../../shared/ipc-contract';
import { molecularDataContract } from '../../shared/ipc/molecular-data.contract';
import type { MolecularDataService } from './service';

export function registerMolecularDataHandlers(service: MolecularDataService): void {
  handleGroup(molecularDataContract, {
    retain: (_event, input) => service.retain(input),
    load: (_event, input) => service.load(input),
  });
}
