// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  GENOME_SOURCE_CREDENTIAL_V1,
  genomeSourceCredentialSummary,
  parseGenomeSourceAuthRef,
  parseGenomeSourceCredential,
} from './genome-source-credentials';

const CANARY = 'INERT_RENDERER_CREDENTIAL_CANARY_123456';

describe('genome source credential contract', () => {
  it.each([
    {
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:bearer',
      kind: 'http-bearer',
      token: CANARY,
    },
    {
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:basic',
      kind: 'http-basic',
      username: 'researcher',
      password: CANARY,
    },
    {
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:header',
      kind: 'http-header',
      headerName: 'X-Research-Token',
      headerValue: CANARY,
    },
    {
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:aws',
      kind: 'aws-sigv4',
      accessKeyId: 'TESTACCESSKEY1234',
      secretAccessKey: CANARY,
      sessionToken: `session-${CANARY}`,
    },
    {
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:gcs',
      kind: 'gcs-oauth',
      accessToken: CANARY,
    },
  ] as const)('parses $kind but exposes only a secret-free summary', (input) => {
    const parsed = parseGenomeSourceCredential(input);
    const summary = genomeSourceCredentialSummary(parsed);

    expect(summary).toEqual({ authRef: input.authRef, kind: input.kind, connected: true });
    expect(JSON.stringify(summary)).not.toContain(CANARY);
  });

  it('rejects unknown fields and renderer-forbidden transport headers', () => {
    expect(() =>
      parseGenomeSourceCredential({
        contract: GENOME_SOURCE_CREDENTIAL_V1,
        authRef: 'source:bad',
        kind: 'http-bearer',
        token: CANARY,
        leaked: CANARY,
      })
    ).toThrow('fields are invalid');

    expect(() =>
      parseGenomeSourceCredential({
        contract: GENOME_SOURCE_CREDENTIAL_V1,
        authRef: 'source:bad-header',
        kind: 'http-header',
        headerName: 'Host',
        headerValue: CANARY,
      })
    ).toThrow('not allowed');
  });

  it('accepts opaque stable references and rejects whitespace or query material', () => {
    expect(parseGenomeSourceAuthRef('team/source_1:v2')).toBe('team/source_1:v2');
    expect(() => parseGenomeSourceAuthRef('source?token=secret')).toThrow('reference is invalid');
    expect(() => parseGenomeSourceAuthRef('source ref')).toThrow('reference is invalid');
  });
});
