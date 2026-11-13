import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';

const PREFIX = 'dfweb1';
const DEFAULT_LIFETIME_SECONDS = 30 * 60;
const MAX_LIFETIME_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_TOKEN_CHARS = 2_048;
const DEPLOYMENT_SHA_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

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
  return decoded.length > 0 &&
    decoded.length <= maximumBytes &&
    decoded.toString('base64') === value
    ? decoded
    : null;
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

function canonicalOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

export function isWebMaintainerSessionAssertion(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_TOKEN_CHARS &&
    /^dfweb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

export function mintWebMaintainerSessionAssertion({
  privateKey,
  origin,
  deploymentSha,
  nowMs = Date.now(),
  lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
  nonce = randomUUID(),
}) {
  const normalizedOrigin = canonicalOrigin(origin);
  if (!normalizedOrigin || !DEPLOYMENT_SHA_RE.test(deploymentSha ?? '')) {
    throw new Error('An exact HTTPS origin and deployment SHA are required');
  }
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds <= 0 ||
    lifetimeSeconds > MAX_LIFETIME_SECONDS
  ) {
    throw new Error(`Session lifetime must be between 1 and ${MAX_LIFETIME_SECONDS} seconds`);
  }
  if (!NONCE_RE.test(nonce)) throw new Error('Session nonce must be a UUIDv4');
  const issuedAt = Math.floor(nowMs / 1_000);
  const claims = {
    d: deploymentSha,
    exp: issuedAt + lifetimeSeconds,
    iat: issuedAt,
    n: nonce,
    o: normalizedOrigin,
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signed = `${PREFIX}.${encoded}`;
  const signature = sign(null, Buffer.from(signed), privateKeyFromBase64(privateKey));
  return `${signed}.${signature.toString('base64url')}`;
}

export function verifyWebMaintainerSessionAssertion({
  token,
  publicKey,
  origin,
  deploymentSha,
  nowMs = Date.now(),
}) {
  if (!isWebMaintainerSessionAssertion(token)) return null;
  const normalizedOrigin = canonicalOrigin(origin);
  const key = publicKeyFromBase64(publicKey);
  if (!normalizedOrigin || !key || !DEPLOYMENT_SHA_RE.test(deploymentSha ?? '')) return null;
  const [prefix, encoded, signatureText] = token.split('.');
  const signature = decodeCanonicalBase64Url(signatureText, 64);
  if (!signature) return null;
  const signed = `${prefix}.${encoded}`;
  if (signature.length !== 64 || !verify(null, Buffer.from(signed), key, signature)) return null;
  const payload = decodeCanonicalBase64Url(encoded, 1_024);
  if (!payload) return null;
  let value;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'd,exp,iat,n,o') return null;
  if (
    value.o !== normalizedOrigin ||
    value.d !== deploymentSha ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp) ||
    typeof value.n !== 'string' ||
    !NONCE_RE.test(value.n)
  ) {
    return null;
  }
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    value.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    value.exp <= value.iat ||
    value.exp - value.iat > MAX_LIFETIME_SECONDS ||
    value.exp <= nowSeconds
  ) {
    return null;
  }
  return {
    origin: value.o,
    deploymentSha: value.d,
    issuedAtMs: value.iat * 1_000,
    expiresAtMs: value.exp * 1_000,
    nonce: value.n,
  };
}
