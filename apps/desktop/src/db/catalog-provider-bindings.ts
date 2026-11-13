import { platform } from '../platform';
export type { RestoreCatalogProviderBindingInput as RestoreProviderBindingInput } from '../shared/catalog-associations';
import type { RestoreCatalogProviderBindingInput } from '../shared/catalog-associations';

export async function restoreProviderBinding(
  input: RestoreCatalogProviderBindingInput
): Promise<void> {
  return platform().db.restoreCatalogProviderBinding(input);
}
