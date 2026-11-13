import { defineGroup, event, invoke } from './contract';
import type {
  ImportReviewChanged,
  ImportReviewDocument,
  ImportReviewInspection,
  ImportReviewRequest,
} from '../import-review';

export const importReviewContract = defineGroup('importReview', {
  call: invoke<[request: ImportReviewRequest], ImportReviewInspection>(),
  snapshot: invoke<[id: string], ImportReviewDocument>(),
  onChanged: event<[event: ImportReviewChanged]>().channel('importReview:changed'),
});
