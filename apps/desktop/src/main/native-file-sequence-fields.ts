import { sourceFormatForPath } from './lims-sequence-io';

export function nativeFileSequenceFields(input: {
  fields: Record<string, unknown>;
  kind: string;
  documentId: string;
}): Record<string, unknown> {
  const sequence = input.fields.sequence;
  if (
    !['dna_sequence', 'rna_sequence'].includes(input.kind) ||
    !sequence ||
    typeof sequence !== 'object' ||
    !('mode' in sequence) ||
    sequence.mode !== 'file' ||
    !('relPath' in sequence) ||
    typeof sequence.relPath !== 'string'
  )
    return input.fields;
  return {
    ...input.fields,
    sequence: {
      ...sequence,
      documentId: input.documentId,
      sequenceId: null,
      sourceFormat: sourceFormatForPath(sequence.relPath),
    },
  };
}
