import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  mintWebMaintainerSessionAssertion,
  verifyWebMaintainerSessionAssertion,
} from './web-maintainer-session.mjs';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const origin = 'https://dnaforge.com';
const deploymentSha = '0123456789abcdef0123456789abcdef01234567';
const nowMs = Date.parse('2026-08-26T20:00:00.000Z');

function nonCanonicalSignatureEncoding(token) {
  const parts = token.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lastIndex = alphabet.indexOf(parts[2].at(-1));
  assert.equal(lastIndex % 4, 0, 'a canonical 64-byte signature has two zero padding bits');
  parts[2] = `${parts[2].slice(0, -1)}${alphabet[lastIndex + 1]}`;
  return parts.join('.');
}

describe('web maintainer session assertion', () => {
  it('binds a short-lived maintainer session to one origin and deployment', () => {
    const token = mintWebMaintainerSessionAssertion({
      privateKey,
      origin,
      deploymentSha,
      nowMs,
    });
    const claims = verifyWebMaintainerSessionAssertion({
      token,
      publicKey,
      origin,
      deploymentSha,
      nowMs,
    });
    assert.equal(claims?.origin, origin);
    assert.equal(claims?.deploymentSha, deploymentSha);
    assert.equal(claims?.issuedAtMs, nowMs);
    assert.equal(claims?.expiresAtMs, nowMs + 30 * 60 * 1_000);
    assert.match(
      claims?.nonce ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('rejects another origin, deployment, signature, and expired session', () => {
    const token = mintWebMaintainerSessionAssertion({
      privateKey,
      origin,
      deploymentSha,
      nowMs,
      lifetimeSeconds: 60,
    });
    assert.equal(
      verifyWebMaintainerSessionAssertion({
        token,
        publicKey,
        origin: 'https://staging.dnaforge.com',
        deploymentSha,
        nowMs,
      }),
      null
    );
    assert.equal(
      verifyWebMaintainerSessionAssertion({
        token,
        publicKey,
        origin,
        deploymentSha: 'abcdef0123456789abcdef0123456789abcdef01',
        nowMs,
      }),
      null
    );
    assert.equal(
      verifyWebMaintainerSessionAssertion({
        token: nonCanonicalSignatureEncoding(token),
        publicKey,
        origin,
        deploymentSha,
        nowMs,
      }),
      null
    );
    assert.equal(
      verifyWebMaintainerSessionAssertion({
        token,
        publicKey,
        origin,
        deploymentSha,
        nowMs: nowMs + 61_000,
      }),
      null
    );
  });
});
