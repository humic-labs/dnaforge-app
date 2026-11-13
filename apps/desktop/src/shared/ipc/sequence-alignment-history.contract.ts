import type { PublishSequenceAlignmentHistoryRequest } from '../sequence-package-evidence';
import { defineGroup, invoke } from './contract';

export const sequenceAlignmentHistoryContract = defineGroup('fs', {
  publishSequenceAlignmentHistory: invoke<
    [input: PublishSequenceAlignmentHistoryRequest],
    string
  >(),
});
