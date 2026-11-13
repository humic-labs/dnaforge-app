export const NATIVE_ENTITY_REFERENCE_PREFIX = 'entity://workspace/' as const;
const LEGACY_MIGRATION_ENTITY_REFERENCE_PREFIX = 'entity://migration/' as const;

const MAX_NATIVE_ENTITY_ID_BYTES = 512;
const SAFE_NATIVE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;

export function isPortableNativeEntityId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.normalize('NFC') === value &&
    new TextEncoder().encode(value).byteLength <= MAX_NATIVE_ENTITY_ID_BYTES &&
    SAFE_NATIVE_ENTITY_ID.test(value)
  );
}

export function nativeEntityReferenceHref(entityId: unknown): string | null {
  return isPortableNativeEntityId(entityId)
    ? `${NATIVE_ENTITY_REFERENCE_PREFIX}${encodeURIComponent(entityId)}`
    : null;
}

export function nativeEntityReferenceIdFromHref(href: string | null): string | null {
  const prefix = href?.startsWith(NATIVE_ENTITY_REFERENCE_PREFIX)
    ? NATIVE_ENTITY_REFERENCE_PREFIX
    : href?.startsWith(LEGACY_MIGRATION_ENTITY_REFERENCE_PREFIX)
      ? LEGACY_MIGRATION_ENTITY_REFERENCE_PREFIX
      : null;
  if (!href || !prefix) return null;
  const encoded = href.slice(prefix.length);
  if (!encoded || /[?#]/u.test(encoded)) return null;
  let entityId: string;
  try {
    entityId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return isPortableNativeEntityId(entityId) ? entityId : null;
}

interface ClosestAnchorElement {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

export function nativeEntityReferenceIdFromElement(
  element: ClosestAnchorElement | null
): string | null {
  const anchor = element?.closest('a[href]');
  return nativeEntityReferenceIdFromHref(anchor?.getAttribute('href') ?? null);
}
