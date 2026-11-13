import { canonicalJson } from './canonical-json';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

export async function annotationTargetDocumentRevision(
  sequence: AnnotatedSequence
): Promise<string> {
  const canonical = canonicalJson({
    annotations: sequence.annotations,
    circular: sequence.circular ?? false,
    description: sequence.description ?? null,
    id: sequence.id,
    length: sequence.length,
    metadata: sequence.metadata ?? null,
    name: sequence.name,
    quality: sequence.quality ?? null,
    sequence: sequence.sequence,
  });
  return `annotation-document-v1:${await sha256Text(canonical)}`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}
