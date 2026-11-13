export const GENOME_SOURCE_CREDENTIAL_V1 = 'dnaforge.genome-source-credential.v1' as const;
export const GENOME_SOURCE_CREDENTIAL_KEYRING_SERVICE = 'dnaforge-genome-source' as const;

export type GenomeSourceCredentialKind =
  | 'http-bearer'
  | 'http-basic'
  | 'http-header'
  | 'aws-sigv4'
  | 'gcs-oauth';

interface GenomeSourceCredentialBase {
  readonly contract: typeof GENOME_SOURCE_CREDENTIAL_V1;
  readonly authRef: string;
  readonly kind: GenomeSourceCredentialKind;
}

export type GenomeSourceCredentialInput =
  | (GenomeSourceCredentialBase & {
      readonly kind: 'http-bearer';
      readonly token: string;
    })
  | (GenomeSourceCredentialBase & {
      readonly kind: 'http-basic';
      readonly username: string;
      readonly password: string;
    })
  | (GenomeSourceCredentialBase & {
      readonly kind: 'http-header';
      readonly headerName: string;
      readonly headerValue: string;
    })
  | (GenomeSourceCredentialBase & {
      readonly kind: 'aws-sigv4';
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
    })
  | (GenomeSourceCredentialBase & {
      readonly kind: 'gcs-oauth';
      readonly accessToken: string;
    });

export interface GenomeSourceCredentialSummary {
  readonly authRef: string;
  readonly kind: GenomeSourceCredentialKind;
  readonly connected: true;
}

export interface GenomeSourceCredentialStatus {
  readonly authRef: string;
  readonly connected: boolean;
}

export interface GenomeSourceCredentialRemovalResult {
  readonly authRef: string;
  readonly removed: boolean;
}

const AUTH_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const AWS_ACCESS_KEY = /^[A-Za-z0-9/+=._-]{8,128}$/u;
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-dnaforge-operation-authority',
  'x-dnaforge-session',
]);

export function parseGenomeSourceCredential(value: unknown): GenomeSourceCredentialInput {
  const candidate = exactRecord(
    value,
    new Set([
      'contract',
      'authRef',
      'kind',
      'token',
      'username',
      'password',
      'headerName',
      'headerValue',
      'accessKeyId',
      'secretAccessKey',
      'sessionToken',
      'accessToken',
    ])
  );
  if (candidate.contract !== GENOME_SOURCE_CREDENTIAL_V1) {
    throw new Error(`Credential contract must be ${GENOME_SOURCE_CREDENTIAL_V1}.`);
  }
  const authRef = parseGenomeSourceAuthRef(candidate.authRef);
  switch (candidate.kind) {
    case 'http-bearer':
      exactKeys(candidate, new Set(['contract', 'authRef', 'kind', 'token']));
      return {
        contract: GENOME_SOURCE_CREDENTIAL_V1,
        authRef,
        kind: 'http-bearer',
        token: secret(candidate.token, 'Bearer token'),
      };
    case 'http-basic':
      exactKeys(candidate, new Set(['contract', 'authRef', 'kind', 'username', 'password']));
      return {
        contract: GENOME_SOURCE_CREDENTIAL_V1,
        authRef,
        kind: 'http-basic',
        username: secret(candidate.username, 'HTTP username', 512),
        password: secret(candidate.password, 'HTTP password'),
      };
    case 'http-header': {
      exactKeys(candidate, new Set(['contract', 'authRef', 'kind', 'headerName', 'headerValue']));
      const headerName = secret(candidate.headerName, 'HTTP header name', 128);
      if (!HEADER_NAME.test(headerName) || FORBIDDEN_HEADERS.has(headerName.toLowerCase())) {
        throw new Error('The custom HTTP credential header is not allowed.');
      }
      return {
        contract: GENOME_SOURCE_CREDENTIAL_V1,
        authRef,
        kind: 'http-header',
        headerName,
        headerValue: secret(candidate.headerValue, 'HTTP header value'),
      };
    }
    case 'aws-sigv4': {
      exactKeys(
        candidate,
        new Set(['contract', 'authRef', 'kind', 'accessKeyId', 'secretAccessKey', 'sessionToken']),
        new Set(['sessionToken'])
      );
      const accessKeyId = secret(candidate.accessKeyId, 'AWS access key ID', 128);
      if (!AWS_ACCESS_KEY.test(accessKeyId)) throw new Error('The AWS access key ID is invalid.');
      const sessionToken = optionalSecret(candidate.sessionToken, 'AWS session token');
      return {
        contract: GENOME_SOURCE_CREDENTIAL_V1,
        authRef,
        kind: 'aws-sigv4',
        accessKeyId,
        secretAccessKey: secret(candidate.secretAccessKey, 'AWS secret access key'),
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
    case 'gcs-oauth':
      exactKeys(candidate, new Set(['contract', 'authRef', 'kind', 'accessToken']));
      return {
        contract: GENOME_SOURCE_CREDENTIAL_V1,
        authRef,
        kind: 'gcs-oauth',
        accessToken: secret(candidate.accessToken, 'GCS access token'),
      };
    default:
      throw new Error('The genomic source credential kind is unsupported.');
  }
}

export function parseGenomeSourceAuthRef(value: unknown): string {
  if (typeof value !== 'string' || !AUTH_REF.test(value.trim())) {
    throw new Error('The genomic source credential reference is invalid.');
  }
  return value.trim();
}

export function genomeSourceCredentialSummary(
  credential: GenomeSourceCredentialInput
): GenomeSourceCredentialSummary {
  return { authRef: credential.authRef, kind: credential.kind, connected: true };
}

function exactRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The genomic source credential is invalid.');
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new Error('The genomic source credential fields are invalid.');
  }
  return candidate;
}

function exactKeys(
  candidate: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set()
): void {
  const keys = Object.keys(candidate);
  if (
    keys.some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => !optional.has(key) && !(key in candidate))
  ) {
    throw new Error('The genomic source credential fields are invalid.');
  }
}

function secret(value: unknown, label: string, maximum = 16_384): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function optionalSecret(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : secret(value, label);
}
