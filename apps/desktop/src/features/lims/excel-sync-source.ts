import { platform } from '../../platform';
import { createLimsImportPlan } from './ingress';
import { createSheetSyncSources } from '../../shared/registry-artifacts/sheet-sync/sources';
export type { ExcelSyncSource } from '../../shared/registry-artifacts/sheet-sync/sources';
export const { parseExcelSyncSource, readExcelSyncSource } = createSheetSyncSources({
  createLimsImportPlan,
  readFile: (path) => platform().fs.readFile(path),
});
