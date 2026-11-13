import type { z } from 'zod';
import { useSequenceStore } from './store';
import { inspectSequenceModel, applySequenceModelCommand } from './sequence-document-command';
import { sequenceEditOperationSchema } from '../../shared/sequence-document';
export { sequenceEditOperationSchema } from '../../shared/sequence-document';

export const inspectSequenceEditState = (documentId: string) =>
  inspectSequenceModel(useSequenceStore.getState(), documentId);
export const applySequenceEditCommand = (input: {
  documentId: string;
  expectedVersion: number;
  operation: z.input<typeof sequenceEditOperationSchema>;
}) => applySequenceModelCommand(useSequenceStore.getState(), input);
