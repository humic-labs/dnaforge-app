import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  resolvePublicTelemetryActor,
  canonicalTelemetryActorDimensions,
  deriveTelemetryActorAssertionPublicKey,
  isTelemetryActorAssertionToken,
  mintTelemetryActorAssertion,
  sealTelemetryActorAssertionPublicKey,
  telemetryActorAssertionPublicKeyFromStamp,
  verifyTelemetryActorAssertion,
  verifyTelemetryActorAssertionResult,
} from './telemetry-actor-assertion.mjs';

const pair = generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const nowMs = Date.parse('2026-08-26T12:00:00.000Z');
const base = {
  privateKey,
  actor: 'maintainer',
  appVersion: '0.8.2',
  buildTag: 'v0.8.2-beta.7',
  releaseChannel: 'closed_beta',
  nowMs,
  nonce: '550e8400-e29b-41d4-a716-446655440001',
};

function nonCanonicalSignatureEncoding(token) {
  const parts = token.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lastIndex = alphabet.indexOf(parts[2].at(-1));
  assert.equal(lastIndex % 4, 0, 'a canonical 64-byte signature has two zero padding bits');
  parts[2] = `${parts[2].slice(0, -1)}${alphabet[lastIndex + 1]}`;
  return parts.join('.');
}

describe('telemetry actor assertion', () => {
  it('mints and verifies one exact maintainer artifact tuple', () => {
    const token = mintTelemetryActorAssertion(base);
    assert.equal(isTelemetryActorAssertionToken(token), true);
    assert.equal(deriveTelemetryActorAssertionPublicKey(privateKey), publicKey);
    assert.equal(
      telemetryActorAssertionPublicKeyFromStamp(sealTelemetryActorAssertionPublicKey(publicKey)),
      publicKey
    );
    assert.equal(
      telemetryActorAssertionPublicKeyFromStamp(sealTelemetryActorAssertionPublicKey('bad')),
      null
    );
    assert.deepEqual(
      verifyTelemetryActorAssertion({
        token,
        publicKey,
        actor: 'maintainer',
        appVersion: '0.8.2',
        buildTag: 'v0.8.2-beta.7',
        releaseChannel: 'closed_beta',
        nowMs,
        eventTimeMs: nowMs,
      }),
      {
        actor: 'maintainer',
        appVersion: '0.8.2',
        buildTag: 'v0.8.2-beta.7',
        releaseChannel: 'closed_beta',
        issuedAt: Math.floor(nowMs / 1_000),
        expiresAt: Math.floor(nowMs / 1_000) + 3_600,
        nonce: '550e8400-e29b-41d4-a716-446655440001',
      }
    );
  });

  it('rejects a changed signature, tuple, actor, CI run, and expiry', () => {
    const token = mintTelemetryActorAssertion({
      ...base,
      actor: 'ci',
      ciRunId: '32902696778',
    });
    const expected = {
      token,
      publicKey,
      actor: 'ci',
      appVersion: '0.8.2',
      buildTag: 'v0.8.2-beta.7',
      releaseChannel: 'closed_beta',
      ciRunId: '32902696778',
      nowMs,
      eventTimeMs: nowMs,
    };
    assert.ok(verifyTelemetryActorAssertion(expected));
    assert.equal(verifyTelemetryActorAssertion({ ...expected, appVersion: '0.8.3' }), null);
    assert.deepEqual(verifyTelemetryActorAssertionResult({ ...expected, appVersion: '0.8.3' }), {
      kind: 'conflict',
    });
    assert.equal(verifyTelemetryActorAssertion({ ...expected, ciRunId: '32902696779' }), null);
    assert.equal(verifyTelemetryActorAssertion({ ...expected, actor: 'maintainer' }), null);
    assert.equal(verifyTelemetryActorAssertion({ ...expected, nowMs: nowMs + 3_601_000 }), null);
    assert.equal(
      verifyTelemetryActorAssertion({
        ...expected,
        token: nonCanonicalSignatureEncoding(token),
      }),
      null
    );
  });

  it('accepts delayed delivery only when occurrence time is inside the signed window', () => {
    const token = mintTelemetryActorAssertion(base);
    const delayed = {
      token,
      publicKey,
      actor: 'maintainer',
      appVersion: '0.8.2',
      buildTag: 'v0.8.2-beta.7',
      releaseChannel: 'closed_beta',
      nowMs: nowMs + 7_200_000,
      eventTimeMs: nowMs + 60_000,
    };

    assert.equal(verifyTelemetryActorAssertion(delayed), null);
    assert.ok(verifyTelemetryActorAssertion({ ...delayed, allowHistoricalReceipt: true }));
    assert.equal(
      verifyTelemetryActorAssertion({
        ...delayed,
        allowHistoricalReceipt: true,
        eventTimeMs: nowMs + 3_601_000,
      }),
      null
    );
  });

  it('makes invalid actor and release combinations unrepresentable', () => {
    assert.throws(() => mintTelemetryActorAssertion({ ...base, actor: 'ci' }), /CI run identifier/);
    assert.throws(
      () => mintTelemetryActorAssertion({ ...base, ciRunId: '32902696778' }),
      /CI run identifier/
    );
    assert.throws(
      () => mintTelemetryActorAssertion({ ...base, releaseChannel: 'prod' }),
      /exact packaged actor/
    );
  });
});

describe('shared public actor resolution', () => {
  it('keeps explicit public actors and requires exact current signatures for privileged actors', () => {
    const input = {
      requestedActor: 'ci',
      assertion: mintTelemetryActorAssertion({ ...base, actor: 'ci', ciRunId: '40641437342' }),
      publicKey,
      appVersion: base.appVersion,
      buildTag: base.buildTag,
      releaseChannel: base.releaseChannel,
      ciRunId: '40641437342',
      nowMs,
      eventTimeMs: nowMs,
    };
    assert.deepEqual(resolvePublicTelemetryActor(input), {
      telemetryActor: 'ci',
      ciRunId: '40641437342',
      assertionAccepted: true,
    });
    for (const change of [
      { assertion: undefined },
      { ciRunId: '40641437343' },
      { appVersion: '0.8.3' },
      { buildTag: 'v0.8.3' },
      { releaseChannel: 'prod' },
      { nowMs: nowMs + 3_601_000 },
      { requestedActor: undefined },
    ]) {
      assert.deepEqual(resolvePublicTelemetryActor({ ...input, ...change }), {
        telemetryActor: null,
        assertionAccepted: false,
      });
    }
    for (const requestedActor of ['user', 'dev', 'canary']) {
      assert.deepEqual(
        resolvePublicTelemetryActor({ ...input, requestedActor, assertion: undefined }),
        { telemetryActor: requestedActor, assertionAccepted: false }
      );
    }
  });

  it('refuses unbounded or inconsistent canonical delivery dimensions', () => {
    assert.deepEqual(
      canonicalTelemetryActorDimensions({ telemetry_actor: 'ci', ci_run_id: '40641437342' }),
      { telemetry_actor: 'ci', ci_run_id: '40641437342' }
    );
    for (const value of [
      null,
      {},
      { telemetry_actor: 'ci' },
      { telemetry_actor: 'user', ci_run_id: '123' },
      { telemetry_actor: 'ci', ci_run_id: '0' },
      { telemetry_actor: 'user', prompt: 'private' },
    ]) {
      assert.equal(canonicalTelemetryActorDimensions(value), null);
    }
  });
});
