export const RELEASE_BUILD_ENV_NAME = 'DNAFORGE_RELEASE_BUILD';
const RELEASE_AUTHORITY_SEGMENTS = ['SCHEMA', 'MIGRATION', 'AUTHORITY', 'V1'] as const;
const RELEASE_AUTHORITY_SUFFIX = RELEASE_AUTHORITY_SEGMENTS.join('_');
export const VALID_RELEASE_BUILD_STAMP = `${RELEASE_BUILD_ENV_NAME}=1::${RELEASE_AUTHORITY_SUFFIX}::END`;
export const MALFORMED_RELEASE_BUILD_STAMP = `${RELEASE_BUILD_ENV_NAME}=INVALID::${RELEASE_AUTHORITY_SUFFIX}::END`;
export const TELEMETRY_BUILD_TAG_ENV_NAME = 'DNAFORGE_BUILD_TAG';
export const RELEASE_B_HOSTED_ENV_NAME = 'DNAFORGE_RELEASE_B_HOSTED';
export const QUALIFICATION_EPHEMERAL_AUTH_ENV_NAME = 'DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH';
export const SOURCE_COMMIT_STAMP_PREFIX = 'DNAFORGE_SOURCE_COMMIT=';
export const SOURCE_COMMIT_STAMP_SUFFIX = 'SOURCE_COMMIT_PROVENANCE_V1::END';
const RELEASE_B_HOSTED_AUTHORITY_SUFFIX = 'HOSTED_GATEWAY_AUTHORITY_V1::END';
const QUALIFICATION_EPHEMERAL_AUTH_AUTHORITY_SUFFIX = 'QUALIFICATION_EPHEMERAL_AUTH_V1::END';
const TELEMETRY_BUILD_TAG_SUFFIX = 'TELEMETRY_PROVENANCE_V1';
const RELEASE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;
export const MALFORMED_TELEMETRY_BUILD_TAG_STAMP = `${TELEMETRY_BUILD_TAG_ENV_NAME}=INVALID::${TELEMETRY_BUILD_TAG_SUFFIX}::END`;

export type ReleaseBuildStampStatus = 'valid' | 'absent' | 'malformed';

export interface ReleaseBuildIdentity {
  status: ReleaseBuildStampStatus;
  isReleaseBuild: boolean;
  stamp: string | null;
}

export interface ReleaseBHostedAuthority {
  readonly enabled: boolean;
  readonly gatewayOrigin: string;
  readonly stamp: string;
}

function canonicalHostedGatewayOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  return url.origin;
}

export function releaseBHostedAuthorityFromEnv(
  rawFlag: string | undefined,
  rawGateway: string | undefined
): ReleaseBHostedAuthority {
  if (rawFlag === undefined || rawFlag === '' || rawFlag === '0') {
    return { enabled: false, gatewayOrigin: '', stamp: '' };
  }
  if (rawFlag !== '1') {
    throw new Error(`${RELEASE_B_HOSTED_ENV_NAME} must be exactly 1 or 0`);
  }
  const gatewayOrigin = canonicalHostedGatewayOrigin(rawGateway);
  if (!gatewayOrigin) {
    throw new Error(
      'DNAFORGE_HOSTED_AI_GATEWAY_URL must be one canonical HTTPS origin when Release B Hosted is enabled'
    );
  }
  return {
    enabled: true,
    gatewayOrigin,
    stamp:
      `${RELEASE_B_HOSTED_ENV_NAME}=1::HOSTED_GATEWAY_ORIGIN=${gatewayOrigin}::` +
      RELEASE_B_HOSTED_AUTHORITY_SUFFIX,
  };
}

export function classifyReleaseBHostedAuthority(
  rawStamp: unknown,
  rawGateway: unknown
): ReleaseBHostedAuthority {
  if (typeof rawStamp !== 'string' || rawStamp === '') {
    return { enabled: false, gatewayOrigin: '', stamp: '' };
  }
  if (typeof rawGateway !== 'string') {
    return { enabled: false, gatewayOrigin: '', stamp: rawStamp };
  }
  const gatewayOrigin = canonicalHostedGatewayOrigin(rawGateway);
  if (!gatewayOrigin) {
    return { enabled: false, gatewayOrigin: '', stamp: rawStamp };
  }
  const expected =
    `${RELEASE_B_HOSTED_ENV_NAME}=1::HOSTED_GATEWAY_ORIGIN=${gatewayOrigin}::` +
    RELEASE_B_HOSTED_AUTHORITY_SUFFIX;
  if (rawStamp !== expected) {
    return { enabled: false, gatewayOrigin: '', stamp: rawStamp };
  }
  return { enabled: true, gatewayOrigin, stamp: rawStamp };
}

export function releaseBuildStampFromEnv(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  return raw === '1' ? VALID_RELEASE_BUILD_STAMP : MALFORMED_RELEASE_BUILD_STAMP;
}

export function telemetryBuildTagStampFromEnv(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  return RELEASE_TAG_RE.test(raw)
    ? `${TELEMETRY_BUILD_TAG_ENV_NAME}=${raw}::${TELEMETRY_BUILD_TAG_SUFFIX}::END`
    : MALFORMED_TELEMETRY_BUILD_TAG_STAMP;
}

export function sourceCommitStamp(raw: string): string {
  if (!/^[0-9a-f]{40}$/u.test(raw)) {
    throw new Error('desktop source commit must be one full lowercase Git SHA');
  }
  return `${SOURCE_COMMIT_STAMP_PREFIX}${raw}::${SOURCE_COMMIT_STAMP_SUFFIX}`;
}

export function qualificationEphemeralAuthStampFromEnv(
  rawFlag: string | undefined,
  sourceCommit: string,
  releaseBHostedAuthority: ReleaseBHostedAuthority
): string {
  if (rawFlag === undefined || rawFlag === '' || rawFlag === '0') return '';
  if (rawFlag !== '1') {
    throw new Error(`${QUALIFICATION_EPHEMERAL_AUTH_ENV_NAME} must be exactly 1 or 0`);
  }
  if (!releaseBHostedAuthority.enabled) {
    throw new Error('qualification ephemeral auth requires valid Release-B Hosted authority');
  }
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('qualification ephemeral auth requires one full lowercase Git SHA');
  }
  return (
    `${QUALIFICATION_EPHEMERAL_AUTH_ENV_NAME}=${sourceCommit}::` +
    QUALIFICATION_EPHEMERAL_AUTH_AUTHORITY_SUFFIX
  );
}

export function qualificationEphemeralAuthSourceFromStamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.match(
    /^DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=([0-9a-f]{40})::QUALIFICATION_EPHEMERAL_AUTH_V1::END$/u
  );
  return match?.[1];
}

export function sourceCommitFromStamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.match(
    /^DNAFORGE_SOURCE_COMMIT=([0-9a-f]{40})::SOURCE_COMMIT_PROVENANCE_V1::END$/u
  );
  return match?.[1];
}

export function buildTagFromTelemetryStamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.match(
    /^DNAFORGE_BUILD_TAG=(v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)::TELEMETRY_PROVENANCE_V1::END$/
  );
  return match?.[1];
}

export function classifyReleaseBuildStamp(raw: unknown): ReleaseBuildIdentity {
  if (raw === undefined || raw === null || raw === '') {
    return {
      status: 'absent',
      isReleaseBuild: false,
      stamp: null,
    };
  }

  if (raw === VALID_RELEASE_BUILD_STAMP) {
    return {
      status: 'valid',
      isReleaseBuild: true,
      stamp: VALID_RELEASE_BUILD_STAMP,
    };
  }

  return {
    status: 'malformed',
    isReleaseBuild: false,
    stamp: String(raw),
  };
}

const bakedReleaseBuildStamp =
  typeof __DNAFORGE_RELEASE_BUILD__ === 'string' ? __DNAFORGE_RELEASE_BUILD__ : '';
const bakedSourceCommitStamp =
  typeof __DNAFORGE_SOURCE_COMMIT__ === 'string' ? __DNAFORGE_SOURCE_COMMIT__ : '';

export const PACKAGED_SOURCE_COMMIT = sourceCommitFromStamp(bakedSourceCommitStamp) ?? null;

export const RELEASE_BUILD_IDENTITY = Object.freeze(
  classifyReleaseBuildStamp(bakedReleaseBuildStamp)
);
