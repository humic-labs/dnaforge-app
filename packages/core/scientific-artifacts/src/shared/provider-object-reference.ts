export const PROVIDER_OBJECT_REFERENCE_PROVIDERS = ['benchling'] as const;
export type ProviderObjectReferenceProvider = (typeof PROVIDER_OBJECT_REFERENCE_PROVIDERS)[number];

export const PROVIDER_OBJECT_CLASSES = [
  'notebook',
  'sequence',
  'protein',
  'protocol',
  'registry_entity',
  'other',
] as const;
export type ProviderObjectClass = (typeof PROVIDER_OBJECT_CLASSES)[number];

export type ProviderObjectReference = {
  provider: ProviderObjectReferenceProvider;

  stableObjectId: string;
  objectClass: ProviderObjectClass;
  canonicalUrl: string | null;

  providerAccountHint: string | null;
};

const EXACT_PROVIDER_STABLE_ID = /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9]{6,}$/u;
const MAX_STABLE_OBJECT_ID_LENGTH = 128;
const MAX_ACCOUNT_HINT_LENGTH = 253;

const FOLDER_ID_PREFIXES = new Set(['fld', 'lib', 'src']);

export function isExactProviderStableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_STABLE_OBJECT_ID_LENGTH &&
    value.normalize('NFC') === value &&
    EXACT_PROVIDER_STABLE_ID.test(value) &&
    !FOLDER_ID_PREFIXES.has(value.slice(0, value.indexOf('_')).toLowerCase())
  );
}

export function isProviderObjectClass(value: unknown): value is ProviderObjectClass {
  return PROVIDER_OBJECT_CLASSES.includes(value as ProviderObjectClass);
}

export function providerObjectClassForStableId(stableObjectId: string): ProviderObjectClass | null {
  if (!isExactProviderStableId(stableObjectId)) return null;
  switch (stableObjectId.slice(0, stableObjectId.indexOf('_')).toLowerCase()) {
    case 'etr':
    case 'entry':
      return 'notebook';
    case 'seq':
    case 'oligo':
      return 'sequence';
    case 'prtn':
      return 'protein';
    case 'prt':
      return 'protocol';
    case 'ent':
    case 'bfi':
      return 'registry_entity';
    default:
      return null;
  }
}

export function providerStableIdFromUrl(value: unknown): string | null {
  if (!isSafeProviderCanonicalUrl(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const found = new Set<string>();
  for (const rawSegment of parsed.pathname.split('/')) {
    if (!rawSegment) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      continue;
    }
    const head = segment.includes('-') ? segment.slice(0, segment.indexOf('-')) : segment;
    if (isExactProviderStableId(head)) found.add(head);
  }
  return found.size === 1 ? [...found][0] : null;
}

export function isSafeProviderCanonicalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    (hostname === 'benchling.com' || hostname.endsWith('.benchling.com'))
  );
}

export function parseProviderObjectReference(value: unknown): ProviderObjectReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!PROVIDER_OBJECT_REFERENCE_PROVIDERS.includes(record.provider as never)) return null;
  if (!isExactProviderStableId(record.stableObjectId)) return null;
  if (!isProviderObjectClass(record.objectClass)) return null;

  const canonicalUrl = isSafeProviderCanonicalUrl(record.canonicalUrl)
    ? (record.canonicalUrl as string)
    : null;
  const providerAccountHint =
    typeof record.providerAccountHint === 'string' &&
    record.providerAccountHint.length > 0 &&
    record.providerAccountHint.length <= MAX_ACCOUNT_HINT_LENGTH
      ? record.providerAccountHint
      : null;

  return {
    provider: record.provider as ProviderObjectReferenceProvider,
    stableObjectId: record.stableObjectId,
    objectClass: record.objectClass,
    canonicalUrl,
    providerAccountHint,
  };
}

export function providerObjectReferenceKey(
  reference: Pick<ProviderObjectReference, 'provider' | 'stableObjectId' | 'objectClass'>
): string {
  return [reference.provider, reference.stableObjectId, reference.objectClass].join('\u0000');
}

export type ProviderReferenceResolution =
  | {
      status: 'resolved';
      entityId: string;
      scope: 'workspace' | 'registry';
      evidence: 'stable_id' | 'reviewed_mapping';
    }
  | { status: 'pending'; reason: 'target_not_imported' | 'identity_missing' }
  | {
      status: 'ambiguous';
      candidateEntityIds: string[];
      reason: 'multiple_exact_candidates' | 'identity_conflict';
    }
  | { status: 'external'; sourceUrl: string }
  | { status: 'source_broken'; reason: string };

export type ProviderReferenceStatus = ProviderReferenceResolution['status'];
