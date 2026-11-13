export class CanonicalBenchlingItemUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalBenchlingItemUrlError';
  }
}

const STABLE_ITEM_ID = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]+$/u;
const STABLE_FOLDER_ID = /^(?:lib|fld|src)_[A-Za-z0-9]+$/u;
const ITEM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROTOCOL_VIEW_SEGMENTS = new Set(['edit', 'sbs']);
const ROOT_ROUTE_FAMILIES_BY_PREFIX = Object.freeze({
  seq: ['sequences', 'dna-sequences'],
  oligo: ['sequences', 'oligos'],
  prtn: ['proteins', 'aa-sequences'],
  etr: ['entries', 'notebook', 'notebook-entries'],
  entry: ['entries', 'notebook', 'notebook-entries'],
  ent: ['registry-entities', 'entities'],
  bfi: ['files'],
  efl: ['files'],
  scrfile: ['files'],
  lib: ['folders'],
  fld: ['folders'],
  src: ['folders'],
} satisfies Record<string, readonly string[]>);
const BENCHLING_STABLE_ID_IN_REFERENCE =
  /\b(?:aa|bfi|efl|ent|entity|entry|etr|file|fld|lib|mixture|obj|oligo|protocol|prt|prtn|reg|rna|scrfile|seq|src)_[A-Za-z0-9_-]+\b/gu;
const MALFORMED_PERCENT_ENCODING = /%(?![A-Fa-f0-9]{2})/u;
const ENCODED_PATH_SEPARATOR_OR_DOT = /%(?:2f|5c|2e)/iu;
const DOT_PATH_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/u;
const URL_AUTHORITY = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/u;

export function canonicalBenchlingItemUrl(
  value: unknown,
  sourceItemId: string,
  organizationBaseUrl: string
): string {
  if (
    typeof value !== 'string' ||
    typeof organizationBaseUrl !== 'string' ||
    !STABLE_ITEM_ID.test(sourceItemId)
  ) {
    throw new CanonicalBenchlingItemUrlError('Benchling item URL authority is missing.');
  }

  const organization = parseSafeAbsoluteUrl(organizationBaseUrl);
  const url = parseSafeUrl(value, organization.origin);

  const organizationPath =
    organization.pathname === '/' ? '/' : organization.pathname.replace(/\/$/u, '');
  const withinOrganization =
    organizationPath === '/' ||
    url.pathname === organizationPath ||
    url.pathname.startsWith(`${organizationPath}/`);
  if (
    organization.protocol !== 'https:' ||
    organization.username ||
    organization.password ||
    organization.port ||
    organization.search ||
    organization.hash ||
    url.protocol !== 'https:' ||
    url.origin !== organization.origin ||
    url.username ||
    url.password ||
    url.port ||
    !withinOrganization
  ) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL escaped its exact organization or item identity.'
    );
  }

  assertNoConflictingReferencedItemId(url, sourceItemId);
  url.pathname = canonicalItemPath(
    url,
    sourceItemId,
    organization.pathname === '/' ? undefined : organization.pathname
  );
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function requireCanonicalBenchlingItemUrl(
  value: unknown,
  sourceItemId: string,
  organizationBaseUrl?: string
): string {
  if (typeof value !== 'string' || !STABLE_ITEM_ID.test(sourceItemId)) {
    throw new CanonicalBenchlingItemUrlError('Benchling item URL authority is missing.');
  }
  const canonical =
    organizationBaseUrl === undefined
      ? canonicalItemUrlWithoutOrganization(value, sourceItemId)
      : canonicalBenchlingItemUrl(value, sourceItemId, organizationBaseUrl);
  if (canonical !== value) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL authority is not the exact canonical item route.'
    );
  }
  return canonical;
}

export function hasCanonicalBenchlingItemUrl(
  value: unknown,
  sourceItemId: string,
  organizationBaseUrl?: string
): value is string {
  try {
    requireCanonicalBenchlingItemUrl(value, sourceItemId, organizationBaseUrl);
    return true;
  } catch {
    return false;
  }
}

function canonicalItemUrlWithoutOrganization(value: string, sourceItemId: string): string {
  const url = parseSafeAbsoluteUrl(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL escaped its exact organization or item identity.'
    );
  }
  url.pathname = canonicalItemPath(url, sourceItemId);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseSafeAbsoluteUrl(value: string): URL {
  return parseSafeUrl(value);
}

function parseSafeUrl(value: string, base?: string): URL {
  assertSafeRawUrl(value);
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw new CanonicalBenchlingItemUrlError('Benchling item URL authority is malformed.');
  }
}

function assertNoConflictingReferencedItemId(url: URL, sourceItemId: string): void {
  const references = [
    ...[...url.searchParams.values()].flatMap((value) => stableIdsInReference(value)),
    ...stableIdsInReference(decodeURIComponent(url.hash.slice(1))),
  ];
  if (references.some((reference) => reference !== sourceItemId)) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL authority contains a conflicting item identity.'
    );
  }
}

function stableIdsInReference(value: string): string[] {
  return [...value.matchAll(BENCHLING_STABLE_ID_IN_REFERENCE)].map(([match]) => match);
}

function assertSafeRawUrl(value: string): void {
  const rawPath = value.split(/[?#]/u, 1)[0];
  if (
    value.length === 0 ||
    value.trim() !== value ||
    MALFORMED_PERCENT_ENCODING.test(value) ||
    ENCODED_PATH_SEPARATOR_OR_DOT.test(rawPath) ||
    DOT_PATH_SEGMENT.test(rawPath) ||
    hasUnsafeAsciiUrlCharacter(rawPath, false) ||
    hasExplicitPort(value)
  ) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL authority contains an ambiguous or unsafe path.'
    );
  }
}

function hasExplicitPort(value: string): boolean {
  const authority = URL_AUTHORITY.exec(value)?.[1];
  if (authority === undefined) return false;
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostAndPort.startsWith('[')) return /\]:/u.test(hostAndPort);
  return hostAndPort.includes(':');
}

function canonicalItemPath(url: URL, sourceItemId: string, organizationPath?: string): string {
  const encodedSegments = url.pathname.split('/').filter(Boolean);
  let decodedSegments: string[];
  try {
    decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL authority contains an ambiguous or unsafe path.'
    );
  }

  const organizationSegments =
    organizationPath === undefined ? null : organizationPath.split('/').filter(Boolean);
  const protocolPath = canonicalProtocolPath(
    encodedSegments,
    decodedSegments,
    sourceItemId,
    organizationSegments
  );
  if (protocolPath !== null) return protocolPath;

  if (decodedSegments.at(-1) === 'edit') {
    decodedSegments.pop();
    encodedSegments.pop();
  }
  const matchingIndexes = decodedSegments.flatMap((segment, index) =>
    isExactItemSegment(segment, sourceItemId) ? [index] : []
  );
  const itemIndex = decodedSegments.length - 1;
  if (matchingIndexes.length !== 1 || matchingIndexes[0] !== itemIndex) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL escaped its exact organization or item identity.'
    );
  }

  const prefix = sourceItemId.slice(0, sourceItemId.indexOf('_'));
  const rootRouteFamilies: readonly string[] = Object.hasOwn(ROOT_ROUTE_FAMILIES_BY_PREFIX, prefix)
    ? ROOT_ROUTE_FAMILIES_BY_PREFIX[prefix as keyof typeof ROOT_ROUTE_FAMILIES_BY_PREFIX]
    : [];
  const rootRoute =
    decodedSegments.length >= 2 &&
    rootRouteFamilies.includes(decodedSegments.at(-2) ?? '') &&
    hasExactRoutePrefix(decodedSegments.slice(0, -2), organizationSegments);
  const parentFolderSegment = decodedSegments.at(-2) ?? '';
  const fileRoute =
    decodedSegments.length >= 3 &&
    decodedSegments.at(-3) === 'f' &&
    isExactOrSluggedFolderSegment(parentFolderSegment) &&
    hasExactRoutePrefix(decodedSegments.slice(0, -3), organizationSegments);
  if (!rootRoute && !fileRoute) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL is not a supported canonical item route.'
    );
  }

  encodedSegments[itemIndex] = sourceItemId;
  return `/${encodedSegments.join('/')}`;
}

function canonicalProtocolPath(
  encodedSegments: string[],
  decodedSegments: string[],
  sourceItemId: string,
  organizationSegments: readonly string[] | null
): string | null {
  if (!sourceItemId.startsWith('prt_')) return null;
  const opaqueProtocolId = sourceItemId.slice('prt_'.length);
  const protocolIndexes = decodedSegments.flatMap((segment, index) =>
    segment === 'protocols' && decodedSegments[index + 1] === opaqueProtocolId ? [index] : []
  );
  if (protocolIndexes.length === 0) return null;
  const genericItemMatches = decodedSegments.filter((segment) =>
    isExactItemSegment(segment, sourceItemId)
  );
  const protocolIndex = protocolIndexes[0];
  const opaqueIdIndex = protocolIndex + 1;
  const suffix = decodedSegments.slice(opaqueIdIndex + 1);
  const exactCanonical =
    protocolIndexes.length === 1 &&
    genericItemMatches.length === 0 &&
    hasExactRoutePrefix(decodedSegments.slice(0, protocolIndex), organizationSegments) &&
    (suffix.length === 0 ||
      (suffix.length === 1 && isSafeProtocolPresentation(suffix[0])) ||
      (suffix.length === 2 &&
        isSafeProtocolPresentation(suffix[0]) &&
        PROTOCOL_VIEW_SEGMENTS.has(suffix[1])));
  if (!exactCanonical) {
    throw new CanonicalBenchlingItemUrlError(
      'Benchling item URL escaped its exact organization or item identity.'
    );
  }
  return `/${encodedSegments.slice(0, opaqueIdIndex + 1).join('/')}`;
}

function isSafeProtocolPresentation(value: string): boolean {
  return (
    value.length > 0 && value !== '.' && value !== '..' && !hasUnsafeAsciiUrlCharacter(value, true)
  );
}

function isExactItemSegment(segment: string, sourceItemId: string): boolean {
  if (segment === sourceItemId) return true;
  if (!segment.startsWith(`${sourceItemId}-`)) return false;
  return ITEM_SLUG.test(segment.slice(sourceItemId.length + 1));
}

function isExactOrSluggedFolderSegment(segment: string): boolean {
  if (STABLE_FOLDER_ID.test(segment)) return true;
  const match = /^((?:lib|fld|src)_[A-Za-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(segment);
  return Boolean(match && STABLE_FOLDER_ID.test(match[1]));
}

function hasExactRoutePrefix(
  candidate: readonly string[],
  organizationSegments: readonly string[] | null
): boolean {
  if (organizationSegments !== null) {
    return (
      candidate.length === organizationSegments.length &&
      organizationSegments.every((segment, index) => candidate[index] === segment)
    );
  }
  return candidate.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !STABLE_ITEM_ID.test(segment) &&
      !hasUnsafeAsciiUrlCharacter(segment, true)
  );
}

function hasUnsafeAsciiUrlCharacter(value: string, rejectSlash: boolean): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || character === '\\' || (rejectSlash && character === '/')) {
      return true;
    }
  }
  return false;
}
