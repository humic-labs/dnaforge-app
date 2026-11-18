import { createLimsImportPlan } from './ingress';
import { createSheetSyncSources } from '../../shared/registry-artifacts/sheet-sync/sources';
export { googleWorksheetImportInput } from '../../shared/registry-artifacts/sheet-sync/sources';
export const { parseGoogleSyncSource } = createSheetSyncSources({
  createLimsImportPlan,
  readFile: async () => {
    throw new Error('This source is a Google worksheet.');
  },
});
