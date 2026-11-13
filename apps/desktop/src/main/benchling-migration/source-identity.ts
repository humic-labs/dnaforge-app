import { createHash } from 'node:crypto';
import type { SourceBinding } from '../../shared/benchling-migration';
import {
  isLocalExportFolderSourceRef,
  isLocalExportNamespaceUrl,
  localExportNamespaceRoot,
} from '../../shared/benchling-migration';

const BENCHLING_HOST = 'benchling.com';
const BENCHLING_TENANT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.benchling\.com$/u;
const LOCAL_EXPORT_PROVENANCE_URN =
  /^urn:dnaforge:benchling-local-export:sha256:[a-f0-9]{64}#[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/u;
const OBJECT_ID_PATTERN = /\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+)\b/g;
const FOLDER_PREFIXES = new Set(['fld', 'lib', 'src']);
const KNOWN_OBJECT_PREFIXES = new Set([
  'bfi',
  'efl',
  'ent',
  'entry',
  'etr',
  'fld',
  'lib',
  'oligo',
  'prt',
  'prtn',
  'scrfile',
  'seq',
  'src',
]);
const PROJECTS_FOLDER_SEGMENT = /^([A-Za-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const BLOCKED_PATH_PREFIXES = ['/1/api/', '/login', '/signin', '/protected-file'];
const ORGANIZATION_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RESERVED_GENERIC_ROUTE_SEGMENTS = new Set([
  '1',
  'account',
  'admin',
  'api',
  'benchling',
  'editor',
  'entries',
  'entry',
  'f',
  'folders',
  'graphql',
  'login',
  'logout',
  'protected-file',
  'protected-native-export',
  'registry',
  'search',
  'settings',
  'signin',
  'www',
]);

export type BenchlingObjectType =
  | 'notebook_entry'
  | 'protocol'
  | 'dna_sequence'
  | 'rna_sequence'
  | 'protein'
  | 'registry_entity'
  | 'attachment'
  | 'file'
  | 'folder'
  | 'unsupported_object';

export type ParsedBenchlingObjectUrl = {
  sourceUrl: string;
  canonicalUrl: string;
  origin: string;
  organizationBaseUrl: string;
  hostname: string;
  objectId: string;
  objectType: BenchlingObjectType;
  route: 'file' | 'folder';
};

export type DetectedBenchlingIdentity = {
  origin: string;
  organizationBaseUrl?: string;
  stableWorkspaceId: string;
  stableUserId: string;
  workspaceName: string;
  accountEmail: string;
};

export class BenchlingSourceIdentityError extends Error {
  constructor(
    readonly code:
      | 'exactly_one_url_required'
      | 'invalid_url'
      | 'invalid_origin'
      | 'not_an_object_url'
      | 'object_id_not_found'
      | 'ambiguous_object_id'
      | 'generic_organization_identity'
      | 'missing_stable_identity'
      | 'protected_account'
      | 'identity_mismatch',
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'BenchlingSourceIdentityError';
  }
}

export function isBenchlingLocalExportProvenanceUrn(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_EXPORT_PROVENANCE_URN.test(value);
}

export function parseExactlyOneBenchlingObjectUrl(
  input: string | URL | Array<string | URL>
): ParsedBenchlingObjectUrl {
  const values = (Array.isArray(input) ? input : [input])
    .map((value) => (value instanceof URL ? value.toString() : String(value ?? '').trim()))
    .filter(Boolean);
  if (values.length !== 1) {
    throw new BenchlingSourceIdentityError(
      'exactly_one_url_required',
      `Benchling migration requires exactly one URL; received ${values.length}.`,
      { count: values.length }
    );
  }

  const raw = values[0];
  if ((raw.match(/https?:\/\//gi) ?? []).length !== 1 || /\s/.test(raw)) {
    throw new BenchlingSourceIdentityError(
      'exactly_one_url_required',
      'Benchling migration requires one URL with no additional text.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BenchlingSourceIdentityError('invalid_url', 'The source is not a valid URL.');
  }
  assertBenchlingHttpsUrl(parsed, raw);

  const lowerPath = parsed.pathname.toLowerCase();
  if (
    BLOCKED_PATH_PREFIXES.some(
      (prefix) => lowerPath === prefix.slice(0, -1) || lowerPath.startsWith(prefix)
    )
  ) {
    throw new BenchlingSourceIdentityError(
      'not_an_object_url',
      'Benchling migration accepts object pages, not API, sign-in, or protected-download URLs.'
    );
  }

  const organizationBaseUrl = benchlingOrganizationBaseUrlFromSourceUrl(raw);
  const projectsFolder = parseProjectsFolderRoute(parsed, raw, organizationBaseUrl);
  if (projectsFolder) {
    return Object.freeze({
      sourceUrl: `${parsed.origin}${parsed.pathname}`,
      canonicalUrl: projectsFolder.canonicalUrl,
      origin: parsed.origin,
      organizationBaseUrl,
      hostname: parsed.hostname.toLowerCase(),
      objectId: projectsFolder.objectId,
      objectType: 'folder',
      route: 'folder',
    });
  }

  const candidates = collectObjectIds(parsed);
  const nonFolderCandidates = candidates.filter(
    (candidate) => !FOLDER_PREFIXES.has(prefixOf(candidate))
  );
  const chosenCandidates = nonFolderCandidates.length > 0 ? nonFolderCandidates : candidates;
  if (new Set(chosenCandidates).size > 1) {
    throw new BenchlingSourceIdentityError(
      'ambiguous_object_id',
      'The Benchling URL identifies more than one possible object.',
      { candidates: [...new Set(chosenCandidates)].sort() }
    );
  }
  const objectId = chosenCandidates[0];
  if (!objectId) {
    throw new BenchlingSourceIdentityError(
      'object_id_not_found',
      'The Benchling URL does not contain a stable object identifier.'
    );
  }

  const objectType = classifyBenchlingObjectId(objectId, parsed);
  const route = objectType === 'folder' ? 'folder' : 'file';
  const sourceUrl = `${parsed.origin}${parsed.pathname}`;
  const canonicalUrl = canonicalizePathObjectUrl(parsed, objectId);
  return Object.freeze({
    sourceUrl,
    canonicalUrl,
    origin: parsed.origin,
    organizationBaseUrl,
    hostname: parsed.hostname.toLowerCase(),
    objectId,
    objectType,
    route,
  });
}

export function canonicalBenchlingAccountIdentity(input: DetectedBenchlingIdentity): {
  origin: string;
  organizationBaseUrl: string;
  stableWorkspaceId: string;
  stableUserId: string;
} {
  const origin = normalizeTenantOrigin(input.origin);
  const organizationBaseUrl = normalizeBenchlingOrganizationBaseUrl(
    origin,
    input.organizationBaseUrl
  );
  const stableWorkspaceId = requireStableIdentifier(input.stableWorkspaceId, 'stableWorkspaceId');
  const stableUserId = requireStableIdentifier(input.stableUserId, 'stableUserId');
  return { origin, organizationBaseUrl, stableWorkspaceId, stableUserId };
}

export function hashBenchlingAccountIdentity(input: DetectedBenchlingIdentity): string {
  const canonical = canonicalBenchlingAccountIdentity(input);
  const encoded = JSON.stringify({
    origin: canonical.origin,
    stableUserId: canonical.stableUserId,
    stableWorkspaceId: canonical.stableWorkspaceId,
    ...(canonical.organizationBaseUrl !== canonical.origin
      ? { organizationBaseUrl: canonical.organizationBaseUrl }
      : {}),
  });
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`;
}

export function confirmSourceBinding(input: {
  detected: DetectedBenchlingIdentity;
  chromePairingId: string;
  gmailMailbox?: string;
  gmailMismatchConfirmedAt?: string;
  confirmedAt: string;
}): SourceBinding {
  const accountEmail = normalizeEmail(input.detected.accountEmail);
  const canonical = canonicalBenchlingAccountIdentity(input.detected);
  const gmailMailbox = input.gmailMailbox ? normalizeEmail(input.gmailMailbox) : undefined;
  if (gmailMailbox && gmailMailbox !== accountEmail && !input.gmailMismatchConfirmedAt) {
    throw new BenchlingSourceIdentityError(
      'identity_mismatch',
      'A different Gmail mailbox requires explicit confirmation.'
    );
  }
  return Object.freeze({
    version: 1,
    benchlingOrigin: canonical.origin,
    ...(canonical.organizationBaseUrl !== canonical.origin
      ? { benchlingOrganizationBaseUrl: canonical.organizationBaseUrl }
      : {}),
    benchlingAccountId: canonical.stableUserId,
    benchlingAccountEmail: accountEmail,
    benchlingOrganizationId: canonical.stableWorkspaceId,
    benchlingOrganizationName: requireStableIdentifier(
      input.detected.workspaceName,
      'workspaceName'
    ),
    chromePairingId: requireStableIdentifier(input.chromePairingId, 'chromePairingId'),
    gmailMailbox,
    accountHash: hashBenchlingAccountIdentity(input.detected),
    confirmedAt: input.confirmedAt,
    gmailMismatchConfirmedAt: input.gmailMismatchConfirmedAt,
  });
}

export function assertSourceBindingMatches(
  binding: SourceBinding,
  detected: DetectedBenchlingIdentity
): void {
  const canonical = canonicalBenchlingAccountIdentity(detected);
  const accountHash = hashBenchlingAccountIdentity(detected);
  if (
    binding.accountHash !== accountHash ||
    binding.benchlingAccountEmail !== normalizeEmail(detected.accountEmail) ||
    binding.benchlingOrigin !== canonical.origin ||
    sourceBindingOrganizationBaseUrl(binding) !== canonical.organizationBaseUrl ||
    binding.benchlingAccountId !== canonical.stableUserId ||
    binding.benchlingOrganizationId !== canonical.stableWorkspaceId
  ) {
    throw new BenchlingSourceIdentityError(
      'identity_mismatch',
      'The active Benchling account or organization no longer matches this project binding.',
      { expectedAccountHash: binding.accountHash, detectedAccountHash: accountHash }
    );
  }
}

export function sourceBindingOrganizationBaseUrl(
  binding: Pick<SourceBinding, 'benchlingOrigin' | 'benchlingOrganizationBaseUrl'>
): string {
  return normalizeBenchlingOrganizationBaseUrl(
    binding.benchlingOrigin,
    binding.benchlingOrganizationBaseUrl
  );
}

export function normalizeBenchlingOrganizationBaseUrl(
  origin: string,
  organizationBaseUrl?: string
): string {
  const canonicalOrigin = normalizeTenantOrigin(origin);
  const originUrl = new URL(canonicalOrigin);
  const hostname = originUrl.hostname.toLowerCase();
  if (hostname !== BENCHLING_HOST) {
    if (organizationBaseUrl === undefined || organizationBaseUrl === canonicalOrigin) {
      return canonicalOrigin;
    }
    throw new BenchlingSourceIdentityError(
      'invalid_origin',
      'A tenant-subdomain identity cannot declare a different organization route.'
    );
  }

  if (typeof organizationBaseUrl !== 'string' || !organizationBaseUrl.trim()) {
    throw new BenchlingSourceIdentityError(
      'generic_organization_identity',
      'A generic benchling.com identity requires an exact organization route.'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(organizationBaseUrl);
  } catch {
    throw new BenchlingSourceIdentityError(
      'invalid_origin',
      'Benchling organization route must be an absolute URL.'
    );
  }
  assertBenchlingHttpsUrl(parsed, organizationBaseUrl);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const slug = segments[0]?.toLowerCase() ?? '';
  if (
    parsed.origin !== canonicalOrigin ||
    parsed.search ||
    parsed.hash ||
    segments.length !== 1 ||
    slug !== segments[0] ||
    !ORGANIZATION_SLUG.test(slug) ||
    RESERVED_GENERIC_ROUTE_SEGMENTS.has(slug)
  ) {
    throw new BenchlingSourceIdentityError(
      'generic_organization_identity',
      'A generic benchling.com identity requires one exact organization path segment.'
    );
  }
  return `${canonicalOrigin}/${slug}`;
}

export function benchlingOrganizationBaseUrlFromSourceRef(ref: {
  id: string;
  url: string;
}): string | null {
  if (isLocalExportFolderSourceRef(ref)) return null;
  return benchlingOrganizationBaseUrlFromSourceUrl(ref.url);
}

export function benchlingOrganizationBaseUrlFromSourceUrl(value: string | URL): string {
  const raw = value instanceof URL ? value.toString() : value;
  if (typeof raw === 'string' && isLocalExportNamespaceUrl(raw)) {
    return localExportNamespaceRoot(raw);
  }
  if (typeof raw !== 'string' || raw.includes('\\') || /%(?:2e|2f|5c)/iu.test(raw)) {
    throw new BenchlingSourceIdentityError(
      'invalid_url',
      'The source URL contains an ambiguous path encoding.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BenchlingSourceIdentityError('invalid_url', 'The source is not a valid URL.');
  }
  assertBenchlingHttpsUrl(parsed, raw);

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== BENCHLING_HOST) return normalizeTenantOrigin(parsed.origin);

  const segments = parsed.pathname.split('/').filter(Boolean);
  const firstSegment = segments[0] ?? '';
  if (
    firstSegment !== firstSegment.toLowerCase() ||
    !ORGANIZATION_SLUG.test(firstSegment) ||
    RESERVED_GENERIC_ROUTE_SEGMENTS.has(firstSegment)
  ) {
    throw new BenchlingSourceIdentityError(
      'generic_organization_identity',
      'A generic benchling.com source URL requires one explicit organization path segment.'
    );
  }
  return normalizeBenchlingOrganizationBaseUrl(parsed.origin, `${parsed.origin}/${firstSegment}`);
}

export function isUrlWithinBenchlingOrganization(
  value: string | URL,
  organizationBaseUrl: string
): boolean {
  try {
    const rawValue = value instanceof URL ? value.toString() : value;
    if (typeof rawValue === 'string' && isLocalExportNamespaceUrl(organizationBaseUrl)) {
      return (
        isLocalExportNamespaceUrl(rawValue) &&
        localExportNamespaceRoot(rawValue) === organizationBaseUrl
      );
    }
    if (
      typeof rawValue !== 'string' ||
      rawValue.includes('\\') ||
      /%(?:2e|2f|5c)/iu.test(rawValue) ||
      organizationBaseUrl.includes('\\') ||
      /%(?:2e|2f|5c)/iu.test(organizationBaseUrl)
    ) {
      return false;
    }
    const base = new URL(organizationBaseUrl);
    const candidate = new URL(rawValue, `${base}/`);
    if (
      base.protocol !== 'https:' ||
      candidate.protocol !== 'https:' ||
      candidate.username ||
      candidate.password ||
      candidate.origin !== base.origin
    ) {
      return false;
    }
    const basePath = base.pathname.replace(/\/+$/u, '') || '/';
    return (
      basePath === '/' ||
      candidate.pathname === basePath ||
      candidate.pathname.startsWith(`${basePath}/`)
    );
  } catch {
    return false;
  }
}

export function isBenchlingUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname.toLowerCase() === BENCHLING_HOST ||
        parsed.hostname.toLowerCase().endsWith(`.${BENCHLING_HOST}`))
    );
  } catch {
    return false;
  }
}

function assertBenchlingHttpsUrl(parsed: URL, raw: string): void {
  const hostname = parsed.hostname.toLowerCase();
  const tenantLabel = hostname.endsWith(`.${BENCHLING_HOST}`)
    ? hostname.slice(0, -`.${BENCHLING_HOST}`.length)
    : '';
  const explicitPort = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/
    .exec(raw)?.[1]
    ?.split('@')
    .at(-1)
    ?.match(/:\d+$/);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    explicitPort ||
    (hostname !== BENCHLING_HOST &&
      (!BENCHLING_TENANT_HOST.test(hostname) || tenantLabel === 'benchling'))
  ) {
    throw new BenchlingSourceIdentityError(
      'invalid_origin',
      'The source URL must use HTTPS on benchling.com without credentials or a custom port.'
    );
  }
}

function normalizeTenantOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(requireStableIdentifier(value, 'origin'));
  } catch {
    throw new BenchlingSourceIdentityError(
      'invalid_origin',
      'Benchling organization origin must be an absolute URL.'
    );
  }
  assertBenchlingHttpsUrl(parsed, value);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new BenchlingSourceIdentityError(
      'invalid_origin',
      'Benchling provider origin must not contain a path, query, or fragment.'
    );
  }
  if (hostname === `www.${BENCHLING_HOST}` || hostname === `benchling.${BENCHLING_HOST}`) {
    throw new BenchlingSourceIdentityError(
      'generic_organization_identity',
      'The generic benchling.com www host is not a valid organization identity.'
    );
  }
  return parsed.origin;
}

function collectObjectIds(parsed: URL): string[] {
  const values = [
    ...parsed.pathname.split('/').map(decodeLoose),
    ...[...parsed.searchParams.values()],
    decodeLoose(parsed.hash),
  ];
  const ids = values.flatMap((value) =>
    [...value.matchAll(OBJECT_ID_PATTERN)].map((match) => normalizeObjectId(match[1]))
  );
  return [...new Set(ids.filter((value): value is string => Boolean(value)))];
}

function parseProjectsFolderRoute(
  parsed: URL,
  raw: string,
  organizationBaseUrl: string
): { objectId: string; canonicalUrl: string } | null {
  const base = new URL(organizationBaseUrl);
  const organizationSegments = base.pathname.split('/').filter(Boolean);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const routeIndex = organizationSegments.length;
  if (
    parsed.origin !== base.origin ||
    !organizationSegments.every((segment, index) => segments[index] === segment) ||
    segments[routeIndex] !== 'f_'
  ) {
    return null;
  }

  if (segments[routeIndex + 1] === 'folder') return null;

  const rawPath = rawAbsoluteUrlPath(raw);
  const terminalSegment = segments[routeIndex + 1] ?? '';
  const match = PROJECTS_FOLDER_SEGMENT.exec(terminalSegment);
  if (
    parsed.hash ||
    parsed.pathname.includes('//') ||
    rawPath.includes('\\') ||
    /%/u.test(rawPath) ||
    /\/(?:\.{1,2})(?:\/|$)/u.test(rawPath) ||
    segments.length !== routeIndex + 2 ||
    !match
  ) {
    throw new BenchlingSourceIdentityError(
      'not_an_object_url',
      'The Benchling Projects URL is not an exact folder root.'
    );
  }

  const objectId = `lib_${match[1]}`;
  assertProjectsQueryMatchesFolder(parsed, objectId);
  return {
    objectId,
    canonicalUrl: `${organizationBaseUrl}/f/${objectId}`,
  };
}

function assertProjectsQueryMatchesFolder(parsed: URL, objectId: string): void {
  const queryObjectIds = [...parsed.searchParams.values()]
    .flatMap(extractObjectIds)
    .filter((candidate) => KNOWN_OBJECT_PREFIXES.has(prefixOf(candidate)));
  const folderClauses = parsed.searchParams
    .getAll('filter')
    .flatMap((value) => [...value.matchAll(/(?:^|;)folder:([^;]*)/gu)].map((match) => match[1]));
  const directFolderValues = parsed.searchParams.getAll('folder');
  const claimedIds = [...queryObjectIds, ...folderClauses, ...directFolderValues]
    .map(normalizeObjectId)
    .filter((candidate): candidate is string => Boolean(candidate));
  const malformedFolderClaim = [...folderClauses, ...directFolderValues].some(
    (candidate) => normalizeObjectId(candidate) === null
  );
  if (malformedFolderClaim || claimedIds.some((candidate) => candidate !== objectId)) {
    throw new BenchlingSourceIdentityError(
      'ambiguous_object_id',
      'The Benchling Projects URL folder identity does not match its route.'
    );
  }
}

function rawAbsoluteUrlPath(raw: string): string {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/u.exec(raw);
  return match?.[1] || '/';
}

function classifyBenchlingObjectId(objectId: string, url: URL): BenchlingObjectType {
  const hints = `${url.pathname} ${url.search}`.toLowerCase();
  switch (prefixOf(objectId)) {
    case 'etr':
    case 'entry':
      return 'notebook_entry';
    case 'prt':
      return 'protocol';
    case 'seq':
      return /(?:^|[/_?=&-])rna(?:$|[/_?=&-])/.test(hints) ? 'rna_sequence' : 'dna_sequence';
    case 'prtn':
      return 'protein';
    case 'ent':
      return 'registry_entity';
    case 'efl':
      return 'attachment';
    case 'bfi':
    case 'scrfile':
      return 'file';
    case 'fld':
    case 'lib':
    case 'src':
      return 'folder';
    default:
      return 'unsupported_object';
  }
}

function canonicalizePathObjectUrl(parsed: URL, objectId: string): string {
  const segments = parsed.pathname.split('/');
  const objectSegmentIndex = segments.findIndex((segment) =>
    extractObjectIds(decodeLoose(segment)).includes(objectId)
  );
  if (objectSegmentIndex < 0) return `${parsed.origin}${parsed.pathname}`;
  const kept = segments.slice(0, objectSegmentIndex + 1);
  kept[objectSegmentIndex] = objectId;
  const pathname = kept.map((segment) => encodeURIComponent(decodeLoose(segment))).join('/');
  return `${parsed.origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function extractObjectIds(value: string): string[] {
  return [...value.matchAll(OBJECT_ID_PATTERN)]
    .map((match) => normalizeObjectId(match[1]))
    .filter((id): id is string => Boolean(id));
}

function normalizeObjectId(value: string): string | null {
  const match = String(value).match(/^([A-Za-z][A-Za-z0-9]*)_([A-Za-z0-9]+)$/);
  return match ? `${match[1].toLowerCase()}_${match[2]}` : null;
}

function prefixOf(objectId: string): string {
  return objectId.slice(0, objectId.indexOf('_')).toLowerCase();
}

function requireStableIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BenchlingSourceIdentityError(
      'missing_stable_identity',
      `${label} must be a non-empty stable identifier.`
    );
  }
  return value.trim();
}

function normalizeEmail(value: string): string {
  return requireStableIdentifier(value, 'accountEmail').toLowerCase();
}

function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
