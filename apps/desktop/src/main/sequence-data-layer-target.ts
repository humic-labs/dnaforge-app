import { createHash } from 'node:crypto';
import { isBinarySequencePath, parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  fingerprintSequenceDataLayerAnnotations,
  sequenceDataLayerAnnotationCandidates,
} from '../shared/sequence-data-layer-annotations';
import type { SequenceDataLayerTargetSnapshot } from '../shared/sequence-data-layer';

export async function sequenceDataLayerTargetFromBytes(
  documentId: string,
  sourcePath: string,
  bytes: Uint8Array
): Promise<SequenceDataLayerTargetSnapshot> {
  const input = isBinarySequencePath(sourcePath)
    ? bytes
    : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const sequence = parseSequenceFileAsDocument(input, sourcePath).sequence;
  const annotations = sequenceDataLayerAnnotationCandidates(sequence);
  return {
    documentId,
    sequenceFingerprint: `sha256:${createHash('sha256').update(sequence.sequence.toUpperCase()).digest('hex')}`,
    annotationFingerprint: await fingerprintSequenceDataLayerAnnotations(annotations),
    length: sequence.sequence.length,
    annotations,
  };
}
