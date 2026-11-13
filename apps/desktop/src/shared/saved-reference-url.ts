const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = 'dnaforge-chat://reference/';

export function savedReferenceIdFromHref(href: string | null | undefined): string | null {
  if (!href?.startsWith(PREFIX) || href.length > 2_048) return null;
  try {
    const id = decodeURIComponent(href.slice(PREFIX.length));
    return id.length === 36 && UUID.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function savedReferenceHref(referenceId: string): string {
  if (referenceId.length !== 36 || !UUID.test(referenceId))
    throw new Error('Invalid saved reference identifier.');
  return `${PREFIX}${referenceId.toLowerCase()}`;
}
