import { importReviewSchema } from '../../../shared/import-review-command';
export { importReviewSchema } from '../../../shared/import-review-command';
import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';

export const IMPORT_REVIEW_DESCRIPTION =
  'Prepare a retained import review without opening the import wizard. Inspect bounded record pages and exact schema mappings, explicitly accept or skip records and resolve duplicate or relationship candidates. Mutations require the current review revision. Apply uses a stable caller request ID and retains the exact outcome; repeating the same apply never writes twice. Source bytes and schema revisions are checked before canonical file-authoritative apply. A failed or interrupted attempt must be inspected and reconciled; it cannot be blindly replayed. CSV, TSV, Excel, GenBank and FASTA use the existing import planners. Only current admitted projects and source files are allowed. External primer calculations also require the current external-compute:tm permission. Spreadsheet synchronization uses operation sheet-sync with native prepare, connect, list, inspect, pull, pause and device authorization commands. Connect requires its native preparedId and a stable requestId. Inspect a partial Connect by requestId and recover it explicitly; a request ID is not a crash transaction. Excel requires a workbook selected by the native file picker. Google operations refuse agents without a verified provider identity rather than using the human account.';

export function createImportReviewTool(_folders: readonly WorkspaceFolder[]) {
  return resultTool({
    description: IMPORT_REVIEW_DESCRIPTION,
    inputSchema: importReviewSchema,
    execute: async () =>
      toolFailure({
        code: 'IMPORT_REVIEW_NATIVE_ROUTE_REQUIRED',
        error:
          'Import review requires the authenticated native command route. Reconnect the current agent runtime; a renderer cannot supply human authority for this command.',
        retriable: false,
        stateChanged: false,
        partialEffects: [],
      }),
  });
}
