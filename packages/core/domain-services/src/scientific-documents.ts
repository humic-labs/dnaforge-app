const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

declare const workspaceIdentityBrand: unique symbol;
declare const documentIdentityBrand: unique symbol;

export type WorkspaceIdentity = string & { readonly [workspaceIdentityBrand]: true };
export type ScientificDocumentIdentity = string & { readonly [documentIdentityBrand]: true };

export type ScientificDocumentFormat = 'genbank' | 'scientific-json' | 'text' | 'binary';

export type ScientificDocumentRouteSupport =
  | { readonly route: 'desktop'; readonly access: 'read-write' }
  | { readonly route: 'browser'; readonly access: 'read-only' }
  | {
      readonly route: 'browser';
      readonly access: 'unsupported';
      readonly reason: 'native-dialog' | 'local-mutation' | 'unsupported-format';
    };

export type ScientificDocumentRevision =
  | { readonly kind: 'local-file'; readonly contentSha256: string }
  | ScientificAcceptedDocumentRevision
  | {
      readonly kind: 'published-bundle';
      readonly shareId: string;
      readonly policy: 'legacy_snapshot' | 'pinned_version' | 'deep_bundle';
      readonly contentSha256: string;
      readonly versionId: string | null;
    };

export interface ScientificAcceptedDocumentRevision {
  readonly kind: 'accepted-object';
  readonly contentSha256: string;
  readonly resourceId: string;
  readonly resourceRevisionId: string;
  readonly workspaceVersionId: string;
  readonly sequenceEditParentEventId: string | null;
}

export interface ScientificDocumentSnapshot {
  readonly workspace: WorkspaceIdentity;
  readonly document: ScientificDocumentIdentity;
  readonly name: string;
  readonly format: ScientificDocumentFormat;
  readonly content: string;
  readonly byteLength: number;
  readonly revision: ScientificDocumentRevision;
  readonly support: ScientificDocumentRouteSupport;
}

export type ScientificDocumentErrorCode =
  | 'INVALID_WORKSPACE_IDENTITY'
  | 'INVALID_DOCUMENT_IDENTITY'
  | 'DOCUMENT_NOT_FOUND'
  | 'INVALID_ENCODING'
  | 'ACCESS_DENIED'
  | 'SERVICE_UNAVAILABLE'
  | 'CANCELLED'
  | 'UNSUPPORTED_FORMAT';

export interface ScientificDocumentFailure {
  readonly ok: false;
  readonly error: {
    readonly code: ScientificDocumentErrorCode;
    readonly message: string;
  };
}

export type ScientificDocumentReadResult =
  | { readonly ok: true; readonly document: ScientificDocumentSnapshot }
  | ScientificDocumentFailure;

export interface ScientificDocumentReadRequest {
  readonly workspace: WorkspaceIdentity;
  readonly document: ScientificDocumentIdentity;
  readonly signal?: AbortSignal;
}

export interface ScientificDocumentReader {
  read(request: ScientificDocumentReadRequest): Promise<ScientificDocumentReadResult>;
}

export function parseWorkspaceIdentity(value: unknown): WorkspaceIdentity {
  if (typeof value !== 'string' || !WORKSPACE_ID.test(value)) {
    throw new ScientificDocumentContractError(
      'INVALID_WORKSPACE_IDENTITY',
      'Workspace identity must be a stable product identifier.'
    );
  }
  return value as WorkspaceIdentity;
}

export function parseScientificDocumentIdentity(value: unknown): ScientificDocumentIdentity {
  if (typeof value !== 'string') return invalidDocumentIdentity();
  const normalized = value.replace(/\\/gu, '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return invalidDocumentIdentity();
  }
  return normalized as ScientificDocumentIdentity;
}

export function scientificDocumentFormat(
  document: ScientificDocumentIdentity,
  contentType?: string
): ScientificDocumentFormat {
  const lower = document.toLowerCase();
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    lower.endsWith('.gb') ||
    lower.endsWith('.gbk') ||
    mediaType === 'text/x-genbank' ||
    mediaType === 'chemical/x-genbank'
  ) {
    return 'genbank';
  }
  if (lower.endsWith('.json') || mediaType === 'application/json') return 'scientific-json';
  if (!mediaType || mediaType.startsWith('text/')) return 'text';
  return 'binary';
}

export function validateScientificDocumentSnapshot(
  value: ScientificDocumentSnapshot
): ScientificDocumentSnapshot {
  parseWorkspaceIdentity(value.workspace);
  parseScientificDocumentIdentity(value.document);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    throw new TypeError('Scientific document byteLength must be a non-negative safe integer.');
  }
  if (!SHA256.test(value.revision.contentSha256)) {
    throw new TypeError('Scientific document revision requires a lowercase SHA-256 digest.');
  }
  if (value.revision.kind === 'accepted-object') {
    const revision = value.revision;
    if (
      typeof revision.resourceId !== 'string' ||
      !revision.resourceId ||
      !/^rr_[0-9a-f]{64}$/u.test(revision.resourceRevisionId) ||
      !/^wv_[0-9a-f]{64}$/u.test(revision.workspaceVersionId) ||
      (revision.sequenceEditParentEventId !== null &&
        (typeof revision.sequenceEditParentEventId !== 'string' ||
          !revision.sequenceEditParentEventId))
    )
      throw new TypeError('Accepted scientific document requires exact immutable identities.');
  }
  if (new TextEncoder().encode(value.content).byteLength !== value.byteLength) {
    throw new TypeError('Scientific document byteLength does not match its UTF-8 content.');
  }
  return value;
}

export function scientificDocumentFailure(
  code: ScientificDocumentErrorCode,
  message: string
): ScientificDocumentFailure {
  return { ok: false, error: { code, message } };
}

export class ScientificDocumentContractError extends Error {
  readonly code: Extract<
    ScientificDocumentErrorCode,
    'INVALID_WORKSPACE_IDENTITY' | 'INVALID_DOCUMENT_IDENTITY'
  >;

  constructor(
    code: Extract<
      ScientificDocumentErrorCode,
      'INVALID_WORKSPACE_IDENTITY' | 'INVALID_DOCUMENT_IDENTITY'
    >,
    message: string
  ) {
    super(message);
    this.name = 'ScientificDocumentContractError';
    this.code = code;
  }
}

function invalidDocumentIdentity(): never {
  throw new ScientificDocumentContractError(
    'INVALID_DOCUMENT_IDENTITY',
    'Scientific document identity must be a workspace-relative path.'
  );
}
