import { platform } from '../../platform';
import { createPrimerBindingOwnershipStore } from '../../shared/primer-artifacts/primer-binding-ownership';
export type {
  PrimerBindingOwnership,
  PrimerBindingOwnershipStore,
} from '../../shared/primer-artifacts/primer-binding-ownership';
export const primerBindingOwnership = createPrimerBindingOwnershipStore(() => platform().db);
