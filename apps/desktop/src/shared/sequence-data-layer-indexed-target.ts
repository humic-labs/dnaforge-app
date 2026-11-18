import type { ReferenceContentIdentity } from './reference-content-identity';

export interface SequenceDataLayerIndexedTarget extends ReferenceContentIdentity {
  readonly referenceId: string;
  readonly chrom: string;
}

export const MAX_INDEXED_SEQUENCE_DATA_LAYER_CONTIG_BASES = 6_000_000;

const PREFIX = 'indexed-reference:';
const MAX_ID_LENGTH = 512;

export function sequenceDataLayerIndexedTargetId(target: SequenceDataLayerIndexedTarget): string {
  for (const value of [target.referenceId, target.chrom]) {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
      throw new Error('Invalid indexed reference target.');
  }
  if (
    ![target.sequenceIdentity, target.annotationIdentity].every((value) =>
      /^[a-f0-9]{64}$/u.test(value)
    )
  )
    throw new Error('Invalid indexed reference content identity.');
  const id = `${PREFIX}${encodeURIComponent(target.referenceId)}:${encodeURIComponent(target.chrom)}:${target.sequenceIdentity}:${target.annotationIdentity}`;
  if (id.length > MAX_ID_LENGTH) throw new Error('Indexed reference target is too long.');
  return id;
}

export function parseSequenceDataLayerIndexedTargetId(
  id: string
): SequenceDataLayerIndexedTarget | null {
  if (!id.startsWith('indexed-reference')) return null;
  if (!id.startsWith(PREFIX) || id.length > MAX_ID_LENGTH)
    throw new Error('Invalid indexed reference target.');
  const parts = id.slice(PREFIX.length).split(':');
  if (parts.length !== 4) throw new Error('Invalid indexed reference target.');
  try {
    const target = {
      referenceId: decodeURIComponent(parts[0]),
      chrom: decodeURIComponent(parts[1]),
      sequenceIdentity: parts[2],
      annotationIdentity: parts[3],
    };
    if (sequenceDataLayerIndexedTargetId(target) !== id)
      throw new Error('Noncanonical indexed reference target.');
    return target;
  } catch {
    throw new Error('Invalid indexed reference target.');
  }
}
