import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';

const ASSERTION_PREFIX = 'dfactor2';
const DEFAULT_LIFETIME_SECONDS = 60 * 60;
const MAX_LIFETIME_SECONDS = 2 * 60 * 60;
const MAX_FUTURE_ISSUED_AT_SECONDS = 5 * 60;
const MAX_ASSERTION_CHARS = 2_048;
const APP_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const BUILD_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const CI_RUN_ID_RE = /^[1-9][0-9]{0,19}$/;
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const PUBLIC_KEY_STAMP_PREFIX = 'DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY=';
const PUBLIC_KEY_STAMP_SUFFIX = '::TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY_V1::END';
const INVALID_PUBLIC_KEY_STAMP = `${PUBLIC_KEY_STAMP_PREFIX}INVALID${PUBLIC_KEY_STAMP_SUFFIX}`;

function decodeBase64(value, maximumBytes) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumBytes * 2 ||
    !BASE64_RE.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > maximumBytes) return null;
  return decoded.toString('base64') === value ? decoded : null;
}

function privateKeyFromBase64(value) {
  const der = decodeBase64(value?.trim(), 128);
  if (!der) throw new Error('TELEMETRY_ACTOR_ASSERTION_PRIVATE_KEY must be base64 PKCS8');
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('TELEMETRY_ACTOR_ASSERTION_PRIVATE_KEY must contain an Ed25519 key');
  }
  return key;
}

function decodeCanonicalBase64Url(value, maximumBytes) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumBytes * 2 ||
    !BASE64URL_RE.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length > 0 &&
    decoded.length <= maximumBytes &&
    decoded.toString('base64url') === value
    ? decoded
    : null;
}

function publicKeyFromBase64(value) {
  const der = decodeBase64(value?.trim(), 128);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function appVersionFromBuildTag(buildTag) {
  return buildTag.match(/^v([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null;
}

function expectedReleaseChannel(buildTag) {
  return buildTag.includes('-') ? 'closed_beta' : 'prod';
}

function validateIdentity({ appVersion, buildTag, releaseChannel }) {
  return (
    typeof appVersion === 'string' &&
    APP_VERSION_RE.test(appVersion) &&
    typeof buildTag === 'string' &&
    BUILD_TAG_RE.test(buildTag) &&
    appVersionFromBuildTag(buildTag) === appVersion.match(/^[^-]+/)?.[0] &&
    (releaseChannel === 'closed_beta' || releaseChannel === 'prod') &&
    expectedReleaseChannel(buildTag) === releaseChannel
  );
}

function decodeClaims(encoded) {
  try {
    const decoded = decodeCanonicalBase64Url(encoded, 1_024);
    if (!decoded) return null;
    const value = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    const actor = value.a;
    const expectedKeys = (
      actor === 'ci'
        ? ['a', 'av', 'bt', 'cr', 'exp', 'iat', 'n', 'rc']
        : ['a', 'av', 'bt', 'exp', 'iat', 'n', 'rc']
    ).sort();
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      return null;
    }
    if (
      (actor !== 'maintainer' && actor !== 'ci') ||
      !validateIdentity({
        appVersion: value.av,
        buildTag: value.bt,
        releaseChannel: value.rc,
      }) ||
      !Number.isSafeInteger(value.iat) ||
      !Number.isSafeInteger(value.exp) ||
      typeof value.n !== 'string' ||
      !NONCE_RE.test(value.n) ||
      (actor === 'ci' && (typeof value.cr !== 'string' || !CI_RUN_ID_RE.test(value.cr)))
    ) {
      return null;
    }
    return {
      actor,
      appVersion: value.av,
      buildTag: value.bt,
      releaseChannel: value.rc,
      ...(actor === 'ci' ? { ciRunId: value.cr } : {}),
      issuedAt: value.iat,
      expiresAt: value.exp,
      nonce: value.n,
    };
  } catch {
    return null;
  }
}

export function isTelemetryActorAssertionToken(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ASSERTION_CHARS &&
    /^dfactor2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

export function sealTelemetryActorAssertionPublicKey(value) {
  if (typeof value !== 'string' || !publicKeyFromBase64(value.trim())) {
    return INVALID_PUBLIC_KEY_STAMP;
  }
  return `${PUBLIC_KEY_STAMP_PREFIX}${value.trim()}${PUBLIC_KEY_STAMP_SUFFIX}`;
}

export function telemetryActorAssertionPublicKeyFromStamp(value) {
  if (typeof value !== 'string') return null;
  const escapedPrefix = PUBLIC_KEY_STAMP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSuffix = PUBLIC_KEY_STAMP_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const encoded = value.match(
    new RegExp(`^${escapedPrefix}([A-Za-z0-9+/]+={0,2})${escapedSuffix}$`)
  )?.[1];
  return encoded && publicKeyFromBase64(encoded) ? encoded : null;
}

export function mintTelemetryActorAssertion({
  privateKey,
  actor,
  appVersion,
  buildTag,
  releaseChannel,
  ciRunId,
  nowMs = Date.now(),
  lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
  nonce = randomUUID(),
}) {
  if (
    (actor !== 'maintainer' && actor !== 'ci') ||
    !validateIdentity({ appVersion, buildTag, releaseChannel })
  ) {
    throw new Error(
      'An exact packaged actor, version, build tag, and release channel are required'
    );
  }
  if (actor === 'ci' ? !CI_RUN_ID_RE.test(ciRunId ?? '') : ciRunId !== undefined) {
    throw new Error('The CI run identifier must exist only for the ci actor');
  }
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds <= 0 ||
    lifetimeSeconds > MAX_LIFETIME_SECONDS
  ) {
    throw new Error(`Assertion lifetime must be between 1 and ${MAX_LIFETIME_SECONDS} seconds`);
  }
  if (!NONCE_RE.test(nonce)) throw new Error('Assertion nonce must be a UUIDv4');
  const issuedAt = Math.floor(nowMs / 1_000);
  const claims = {
    a: actor,
    av: appVersion,
    bt: buildTag,
    rc: releaseChannel,
    ...(actor === 'ci' ? { cr: ciRunId } : {}),
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    n: nonce,
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signed = `${ASSERTION_PREFIX}.${encoded}`;
  const signature = sign(null, Buffer.from(signed), privateKeyFromBase64(privateKey));
  return `${signed}.${signature.toString('base64url')}`;
}

export function verifyTelemetryActorAssertionResult({
  token,
  publicKey,
  actor,
  appVersion,
  buildTag,
  releaseChannel,
  ciRunId,
  eventTimeMs = Date.now(),
  nowMs = Date.now(),
  allowHistoricalReceipt = false,
}) {
  if (!isTelemetryActorAssertionToken(token)) return { kind: 'invalid' };
  const key = publicKeyFromBase64(publicKey);
  if (!key) return { kind: 'invalid' };
  const parts = token.split('.');
  const signed = `${parts[0]}.${parts[1]}`;
  const signature = decodeCanonicalBase64Url(parts[2], 64);
  if (!signature) return { kind: 'invalid' };
  if (signature.length !== 64 || !verify(null, Buffer.from(signed), key, signature)) {
    return { kind: 'invalid' };
  }
  const claims = decodeClaims(parts[1]);
  if (!claims) return { kind: 'invalid' };
  const eventSeconds = Math.floor(eventTimeMs / 1_000);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    claims.issuedAt > nowSeconds + MAX_FUTURE_ISSUED_AT_SECONDS ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MAX_LIFETIME_SECONDS ||
    (!allowHistoricalReceipt && claims.expiresAt < nowSeconds) ||
    eventSeconds < claims.issuedAt - MAX_FUTURE_ISSUED_AT_SECONDS ||
    eventSeconds > claims.expiresAt
  ) {
    return { kind: 'invalid' };
  }
  if (
    claims.actor !== actor ||
    claims.appVersion !== appVersion ||
    claims.buildTag !== buildTag ||
    claims.releaseChannel !== releaseChannel ||
    (claims.actor === 'ci' && claims.ciRunId !== ciRunId)
  ) {
    return { kind: 'conflict' };
  }
  return { kind: 'accepted', claims };
}

export function verifyTelemetryActorAssertion(input) {
  const result = verifyTelemetryActorAssertionResult(input);
  return result.kind === 'accepted' ? result.claims : null;
}

export function deriveTelemetryActorAssertionPublicKey(privateKey) {
  return createPublicKey(privateKeyFromBase64(privateKey))
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
}

export function resolvePublicTelemetryActor(input) {
  const actor =
    typeof input.requestedActor === 'string' ? input.requestedActor.trim().toLowerCase() : null;
  if (actor === 'user' || actor === 'dev' || actor === 'canary') {
    return { telemetryActor: actor, assertionAccepted: false };
  }
  if (actor !== 'maintainer' && actor !== 'ci') {
    return { telemetryActor: null, assertionAccepted: false };
  }
  const ciRunId =
    actor === 'ci' && typeof input.ciRunId === 'string' && CI_RUN_ID_RE.test(input.ciRunId)
      ? input.ciRunId
      : undefined;
  const result = verifyTelemetryActorAssertionResult({
    token: input.assertion,
    publicKey: input.publicKey,
    actor,
    appVersion: input.appVersion,
    buildTag: input.buildTag,
    releaseChannel: input.releaseChannel,
    ...(ciRunId ? { ciRunId } : {}),
    eventTimeMs: input.eventTimeMs ?? Date.now(),
    nowMs: input.nowMs ?? Date.now(),
    allowHistoricalReceipt: input.allowHistoricalReceipt ?? false,
  });
  if (result.kind !== 'accepted') return { telemetryActor: null, assertionAccepted: false };
  return {
    telemetryActor: result.claims.actor,
    ...(result.claims.actor === 'ci' ? { ciRunId: result.claims.ciRunId } : {}),
    assertionAccepted: true,
  };
}

export function canonicalTelemetryActorDimensions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const actor = value.telemetry_actor;
  if (!['user', 'dev', 'canary', 'maintainer', 'ci'].includes(actor)) return null;
  if (actor === 'ci') {
    return keys.length === 2 &&
      keys.includes('ci_run_id') &&
      typeof value.ci_run_id === 'string' &&
      CI_RUN_ID_RE.test(value.ci_run_id)
      ? { telemetry_actor: actor, ci_run_id: value.ci_run_id }
      : null;
  }
  return keys.length === 1 ? { telemetry_actor: actor } : null;
}
