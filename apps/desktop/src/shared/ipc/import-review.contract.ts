import type { SheetSyncRequest, SheetSyncResult } from '../registry-artifacts/sheet-sync/command';
import { defineGroup, event, invoke } from './contract';
import type {
  ImportReviewChanged,
  ImportReviewDocument,
  ImportReviewInspection,
  ImportReviewRequest,
} from '../import-review';

export const importReviewContract = defineGroup('importReview', {
  call: invoke<[request: ImportReviewRequest], ImportReviewInspection>(),
  sheetSync: invoke<[request: SheetSyncRequest], SheetSyncResult>(),
  snapshot: invoke<[id: string], ImportReviewDocument>(),
  onChanged: event<[event: ImportReviewChanged]>().channel('importReview:changed'),
});
