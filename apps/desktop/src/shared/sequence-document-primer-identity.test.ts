import { expect, it } from 'vitest';
import { sequenceDocumentClientCommandSchema } from './sequence-document';
import { createSequenceDocumentModel } from './sequence-document-model';

it('keeps pasted attachment and draft identities through native recovered-draft parsing', () => {
  const model = createSequenceDocumentModel();
  const documentId = 'recovered-primer-document';
  const sequence = {
    id: documentId,
    name: 'Recovered primer',
    sequence: 'ACGT',
    length: 4,
    circular: false,
    annotations: [],
  };
  model.getState().setSequence(documentId, sequence);
  model.getState().dispatchEdit(documentId, {
    type: 'INSERT_FRAGMENT',
    fragment: {
      sequence: 'AT',
      annotations: [],
      primerBindings: [{ primerId: 'primer-id', start: 0, end: 2, strand: 1 }],
    },
  });
  const capture = model.getState().captureForSave(documentId);
  if (!capture) throw new Error('The pasted draft has no Save capture.');
  const draft = model.getState().drafts[documentId];
  const command = sequenceDocumentClientCommandSchema.parse({
    method: 'restoreRecoveredDraft',
    content: {
      sequence: draft.sequence,
      annotations: draft.annotations,
      insertedRanges: draft.insertedRanges,
      deletedRanges: draft.deletedRanges,
      substitutedRanges: draft.substitutedRanges,
      pendingPrimerBindings: draft.pendingPrimerBindings,
      draftLineageId: capture.draftLineageId,
    },
  });
  if (command.method !== 'restoreRecoveredDraft')
    throw new Error('The recovered command changed method.');
  const reopened = createSequenceDocumentModel();
  reopened.getState().setSequence(documentId, sequence);
  expect(reopened.getState().restoreRecoveredDraft(documentId, command.content)).toBe(true);
  const restored = reopened.getState().captureForSave(documentId);
  expect(restored?.draftLineageId).toBe(capture.draftLineageId);
  expect(restored?.pendingPrimerBindings).toEqual(capture.pendingPrimerBindings);
  expect(restored?.pendingPrimerBindings[0].pendingId).toEqual(expect.any(String));
});
