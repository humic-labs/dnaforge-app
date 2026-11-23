import { primerServices } from '../primers/public/primer-services';
import {
  primerBindingOwnership,
  type PrimerBindingOwnershipStore,
} from './primer-binding-ownership';
import * as core from './persist-primer-bindings-core';
export * from './persist-primer-bindings-core';
export const persistRichPastePrimerBindings = (
  input: core.PersistRichPastePrimerBindingsInput,
  persistence: core.RichPastePrimerPersistence = {
    ...primerServices.persistence,
    removeOwnedLegacyBinding: (intent) =>
      primerServices.persistence.deleteLegacyBinding(intent.bindingId, { expectedOwner: intent }),
  },
  ownership: PrimerBindingOwnershipStore = primerBindingOwnership
) => core.persistRichPastePrimerBindings(input, persistence, ownership);
export async function hasRichPastePrimerBindingOwnership(
  documentId: string,
  draftLineageId: string
): Promise<boolean> {
  return (await primerBindingOwnership.load(documentId, draftLineageId)).length > 0;
}
