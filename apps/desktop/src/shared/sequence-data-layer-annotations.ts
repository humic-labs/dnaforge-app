import type { SequenceDataLayerAnnotation } from '@waypoint/genome-data';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { canonicalJson } from './canonical-json';

export function sequenceDataLayerAnnotationCandidates(
  sequence: Pick<AnnotatedSequence, 'annotations'>
): readonly SequenceDataLayerAnnotation[] {
  return sequence.annotations.flatMap((annotation) => {
    const id =
      annotation.canonicalIdentity ??
      annotation.sourceId ??
      annotation.qualifiers?.locus_tag?.[0] ??
      annotation.qualifiers?.ID?.[0];
    return id
      ? [
          {
            id,
            start0: annotation.start - 1,
            end0: annotation.end,
            qualifiers: annotation.qualifiers,
          },
        ]
      : [];
  });
}

export async function fingerprintSequenceDataLayerAnnotations(
  annotations: readonly SequenceDataLayerAnnotation[]
): Promise<string> {
  const projection = annotations.map((annotation) =>
    canonicalJson({
      id: annotation.id,
      start0: annotation.start0,
      end0: annotation.end0,
      locus_tag: [...new Set(annotation.qualifiers?.locus_tag ?? [])].sort(),
      ID: [...new Set(annotation.qualifiers?.ID ?? [])].sort(),
    })
  );
  const canonical = `[${[...new Set(projection)].sort().join(',')}]`;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  return `annotation-mapping-v1:sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}
