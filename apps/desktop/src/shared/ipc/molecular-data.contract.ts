import { defineGroup, invoke } from './contract';
import type {
  MolecularDataRetainInput,
  MolecularDataRetained,
  MolecularDataLoadInput,
  MolecularDataLoaded,
} from '../molecular-data-ipc';

export const molecularDataContract = defineGroup('molecularData', {
  retain: invoke<[input: MolecularDataRetainInput], MolecularDataRetained>(),
  load: invoke<[input: MolecularDataLoadInput], MolecularDataLoaded>(),
});
