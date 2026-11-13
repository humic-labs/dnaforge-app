import type { AnnotationRequest } from '@waypoint/api-client/models';

export async function annotationInputRevision(request: AnnotationRequest): Promise<string> {
  const encoded = JSON.stringify({
    linear: request.linear ?? false,
    sequence: request.sequence.toUpperCase().replace(/ /g, '').replace(/\n/g, ''),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
  return (
    'annotation-input-v1:sha256:' +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
