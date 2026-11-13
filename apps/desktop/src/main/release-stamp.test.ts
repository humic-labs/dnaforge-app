import { describe, expect, it } from 'vitest';

import {
  RELEASE_BUILD_ENV_NAME,
  MALFORMED_RELEASE_BUILD_STAMP,
  MALFORMED_TELEMETRY_BUILD_TAG_STAMP,
  RELEASE_B_HOSTED_ENV_NAME,
  QUALIFICATION_EPHEMERAL_AUTH_ENV_NAME,
  VALID_RELEASE_BUILD_STAMP,
  buildTagFromTelemetryStamp,
  classifyReleaseBHostedAuthority,
  classifyReleaseBuildStamp,
  qualificationEphemeralAuthStampFromEnv,
  qualificationEphemeralAuthSourceFromStamp,
  releaseBHostedAuthorityFromEnv,
  releaseBuildStampFromEnv,
  sourceCommitFromStamp,
  sourceCommitStamp,
  telemetryBuildTagStampFromEnv,
} from './release-stamp';

describe('release build stamp', () => {
  it('accepts only the release-pipeline marker', () => {
    expect(classifyReleaseBuildStamp(VALID_RELEASE_BUILD_STAMP)).toEqual({
      status: 'valid',
      isReleaseBuild: true,
      stamp: VALID_RELEASE_BUILD_STAMP,
    });
  });

  it('seals only the exact build-time value and collapses every malformed value', () => {
    expect(releaseBuildStampFromEnv(undefined)).toBe('');
    expect(releaseBuildStampFromEnv('')).toBe('');
    expect(releaseBuildStampFromEnv('1')).toBe(VALID_RELEASE_BUILD_STAMP);
    expect(releaseBuildStampFromEnv('true')).toBe(MALFORMED_RELEASE_BUILD_STAMP);
    expect(releaseBuildStampFromEnv('10')).toBe(MALFORMED_RELEASE_BUILD_STAMP);
    expect(releaseBuildStampFromEnv('1 ')).toBe(MALFORMED_RELEASE_BUILD_STAMP);
    expect(releaseBuildStampFromEnv(`1::SCHEMA_MIGRATION_AUTHORITY_V1::END`)).toBe(
      MALFORMED_RELEASE_BUILD_STAMP
    );
  });

  it.each([undefined, null, ''])('fails closed when the stamp is absent (%s)', (stamp) => {
    expect(classifyReleaseBuildStamp(stamp)).toMatchObject({
      status: 'absent',
      isReleaseBuild: false,
    });
  });

  it.each([
    RELEASE_BUILD_ENV_NAME,
    `${RELEASE_BUILD_ENV_NAME}=true`,
    `${RELEASE_BUILD_ENV_NAME}=0`,
    MALFORMED_RELEASE_BUILD_STAMP,
    ` ${VALID_RELEASE_BUILD_STAMP}`,
    `${VALID_RELEASE_BUILD_STAMP} `,
  ])('fails closed when the stamp is malformed (%s)', (stamp) => {
    expect(classifyReleaseBuildStamp(stamp)).toEqual({
      status: 'malformed',
      isReleaseBuild: false,
      stamp,
    });
  });

  it('seals an exact release tag for telemetry artifact provenance', () => {
    const stable = telemetryBuildTagStampFromEnv('v0.7.10');
    const beta = telemetryBuildTagStampFromEnv('v0.7.10-beta.2');
    expect(buildTagFromTelemetryStamp(stable)).toBe('v0.7.10');
    expect(buildTagFromTelemetryStamp(beta)).toBe('v0.7.10-beta.2');
    expect(telemetryBuildTagStampFromEnv('feature/sealed-case')).toBe(
      MALFORMED_TELEMETRY_BUILD_TAG_STAMP
    );
    expect(buildTagFromTelemetryStamp(MALFORMED_TELEMETRY_BUILD_TAG_STAMP)).toBeUndefined();
  });

  it('seals and recovers only one full source commit', () => {
    const commit = 'a'.repeat(40);
    const stamp = sourceCommitStamp(commit);
    expect(stamp).toBe(`DNAFORGE_SOURCE_COMMIT=${commit}::SOURCE_COMMIT_PROVENANCE_V1::END`);
    expect(sourceCommitFromStamp(stamp)).toBe(commit);
    expect(sourceCommitFromStamp(`${stamp} `)).toBeUndefined();
    expect(() => sourceCommitStamp('a'.repeat(39))).toThrow(/full lowercase Git SHA/);
    expect(() => sourceCommitStamp('A'.repeat(40))).toThrow(/full lowercase Git SHA/);
  });
});

describe('qualification ephemeral auth stamp', () => {
  const source = 'b'.repeat(40);
  const hosted = releaseBHostedAuthorityFromEnv('1', 'https://hosted.dnaforge.com');

  it('is absent by default and seals only the exact opt-in plus build-derived source', () => {
    expect(qualificationEphemeralAuthStampFromEnv(undefined, source, hosted)).toBe('');
    expect(qualificationEphemeralAuthStampFromEnv('0', source, hosted)).toBe('');
    const stamp = qualificationEphemeralAuthStampFromEnv('1', source, hosted);
    expect(stamp).toBe(
      `DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=${source}::QUALIFICATION_EPHEMERAL_AUTH_V1::END`
    );
    expect(qualificationEphemeralAuthSourceFromStamp(stamp)).toBe(source);
  });

  it('rejects malformed flags, sources, and stamps', () => {
    expect(() => qualificationEphemeralAuthStampFromEnv('true', source, hosted)).toThrow(
      `${QUALIFICATION_EPHEMERAL_AUTH_ENV_NAME} must be exactly 1 or 0`
    );
    expect(() =>
      qualificationEphemeralAuthStampFromEnv('1', source, {
        enabled: false,
        gatewayOrigin: '',
        stamp: '',
      })
    ).toThrow(/valid Release-B Hosted authority/u);
    expect(() => qualificationEphemeralAuthStampFromEnv('1', 'b'.repeat(39), hosted)).toThrow(
      /full lowercase Git SHA/u
    );
    expect(qualificationEphemeralAuthSourceFromStamp('')).toBeUndefined();
    expect(
      qualificationEphemeralAuthSourceFromStamp(
        `DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=${source}::QUALIFICATION_EPHEMERAL_AUTH_V1::END `
      )
    ).toBeUndefined();
  });
});

describe('Release B Hosted authority', () => {
  const gateway = 'https://hosted.dnaforge.com';

  it('is disabled unless the exact build flag is 1', () => {
    expect(releaseBHostedAuthorityFromEnv(undefined, gateway)).toEqual({
      enabled: false,
      gatewayOrigin: '',
      stamp: '',
    });
    expect(releaseBHostedAuthorityFromEnv('0', gateway)).toEqual({
      enabled: false,
      gatewayOrigin: '',
      stamp: '',
    });
    expect(() => releaseBHostedAuthorityFromEnv('true', gateway)).toThrow(
      `${RELEASE_B_HOSTED_ENV_NAME} must be exactly 1 or 0`
    );
  });

  it('seals one canonical HTTPS origin into the artifact authority', () => {
    const authority = releaseBHostedAuthorityFromEnv('1', `${gateway}/`);
    expect(authority).toEqual({
      enabled: true,
      gatewayOrigin: gateway,
      stamp:
        'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https://hosted.dnaforge.com::HOSTED_GATEWAY_AUTHORITY_V1::END',
    });
    expect(classifyReleaseBHostedAuthority(authority.stamp, authority.gatewayOrigin)).toEqual(
      authority
    );
  });

  it.each([
    '',
    'http://hosted.dnaforge.com',
    'https://user:password@hosted.dnaforge.com',
    'https://hosted.dnaforge.com/v1',
    'https://hosted.dnaforge.com?alternate=1',
    'https://hosted.dnaforge.com#alternate',
  ])('rejects a non-origin Release B gateway %j', (rawGateway) => {
    expect(() => releaseBHostedAuthorityFromEnv('1', rawGateway)).toThrow(/canonical HTTPS origin/);
  });

  it('fails closed when the stamp and separately baked origin disagree', () => {
    const authority = releaseBHostedAuthorityFromEnv('1', gateway);
    expect(
      classifyReleaseBHostedAuthority(authority.stamp, 'https://attacker.example')
    ).toMatchObject({ enabled: false, gatewayOrigin: '' });
    expect(classifyReleaseBHostedAuthority(`${authority.stamp} `, gateway)).toMatchObject({
      enabled: false,
      gatewayOrigin: '',
    });
  });
});
