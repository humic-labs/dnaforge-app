import { describe, expect, it } from 'vitest';

import {
  BUNDLED_MANIFESTS,
  COMPUTE_OPERATIONS,
  PROVIDER_CREDENTIAL_ENV_PREFIXES,
  computeCredentialAccount,
  effectiveDriverKind,
  loadBundledManifests,
  parseProviderManifest,
  toolMapEntry,
} from './index';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tamarindRaw(): Record<string, unknown> {
  const raw = BUNDLED_MANIFESTS.find((m) => (m as { id: string }).id === 'tamarind');
  if (!raw) throw new Error('tamarind manifest missing');
  return clone(raw as Record<string, unknown>);
}

describe('bundled manifests', () => {
  it('all bundled providers parse and cover the transports/job models the plan names', () => {
    const manifests = loadBundledManifests();
    expect(manifests.map((m) => m.id).sort()).toEqual([
      'boltz',
      'nvidia-nim',
      'replicate',
      'subseq',
      'tamarind',
    ]);
    const byId = Object.fromEntries(manifests.map((m) => [m.id, m]));
    expect(byId.tamarind.transport).toBe('mcp');
    expect(byId.tamarind.jobModel).toBe('queue');
    expect(byId['nvidia-nim'].transport).toBe('rest');
    expect(byId['nvidia-nim'].schemaVersion).toBe(2);
    expect(effectiveDriverKind(byId['nvidia-nim'])).toBe('nvcf');
    expect(byId['nvidia-nim'].jobModel).toBe('longpoll-202');
    expect(byId['nvidia-nim'].catalog).toBe('static');
    expect(byId.subseq.transport).toBe('rest');
    expect(byId.subseq.jobModel).toBe('async');
    expect(byId.subseq.staging).toBe('multipart');
    expect(byId.boltz.transport).toBe('rest');
    expect(byId.boltz.jobModel).toBe('async');
    expect(byId.boltz.catalog).toBe('static');
    expect(effectiveDriverKind(byId.replicate)).toBe('http-job');
    expect(byId.tamarind.cancellation.mode).toBe('provider');
    expect(byId.subseq.cancellation.mode).toBe('provider');
    expect(byId['nvidia-nim'].cancellation.mode).toBe('unavailable');
    expect(byId.boltz.cancellation.mode).toBe('unavailable');
  });

  it('every manifest has a credential env-prefix scrub list', () => {
    for (const manifest of loadBundledManifests()) {
      expect(PROVIDER_CREDENTIAL_ENV_PREFIXES[manifest.id]?.length).toBeGreaterThan(0);
    }
  });

  it("tamarind's toolMap covers every operation the plan names on Tamarind's MCP", () => {
    const tamarind = loadBundledManifests().find((m) => m.id === 'tamarind');
    if (!tamarind || tamarind.transport !== 'mcp') throw new Error('tamarind must be mcp');
    const names = Object.fromEntries(
      Object.entries(tamarind.toolMap).map(([op, entry]) => [op, toolMapEntry(entry).tool])
    );
    expect(names).toEqual({
      list_tools: 'getAvailableTools',
      get_schema: 'getJobSchema',
      validate: 'validateJob',
      estimate: 'estimateTime',
      submit: 'submitJob',
      status: 'getJobs',
      fetch_result: 'getResult',
      cancel: 'cancelJob',
    });
    expect(toolMapEntry(tamarind.toolMap.submit).args).toEqual({
      jobName: '$label',
      type: '$tool_id',
      settings: '$settings',
    });
    expect(tamarind.statusMap.complete).toBe('completed');
    for (const op of COMPUTE_OPERATIONS) {
      expect(op in tamarind.toolMap).toBe(true);
    }
  });
});

describe('parseProviderManifest', () => {
  it('returns readable path-prefixed errors for a malformed manifest', () => {
    const missingTransport = parseProviderManifest({ schemaVersion: 1, id: 'Bad Id' });
    expect(missingTransport.ok).toBe(false);
    if (!missingTransport.ok) expect(missingTransport.errors.join('\n')).toMatch(/^transport: /m);

    const result = parseProviderManifest({ schemaVersion: 1, id: 'Bad Id', transport: 'rest' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.startsWith('id:'))).toBe(true);
    expect(result.errors.some((e) => e.startsWith('displayName:'))).toBe(true);
    expect(result.errors.every((e) => /^[a-zA-Z0-9_.<>]+: /.test(e))).toBe(true);
  });

  it('rejects http:// URLs', () => {
    const raw = tamarindRaw();
    raw.docsUrl = 'http://app.tamarind.bio/api-docs';
    const result = parseProviderManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/docsUrl: must be an https/);
  });

  it('rejects a credential header outside the allowlist (never Cookie)', () => {
    const raw = tamarindRaw();
    raw.auth = { scheme: 'header', headerName: 'cookie' };
    expect(parseProviderManifest(raw).ok).toBe(false);
  });

  it('requires keyPageUrl for header/bearer auth but not for oauth', () => {
    const raw = tamarindRaw();
    delete raw.keyPageUrl;
    const noKeyPage = parseProviderManifest(raw);
    expect(noKeyPage.ok).toBe(false);
    if (!noKeyPage.ok) expect(noKeyPage.errors.join('\n')).toMatch(/keyPageUrl/);

    raw.auth = {
      scheme: 'oauth',
      authorizationUrl: 'https://example.com/authorize',
      tokenUrl: 'https://example.com/token',
    };
    expect(parseProviderManifest(raw).ok).toBe(true);
  });

  it("requires toolMap.estimate when cost is 'estimate' on an MCP provider", () => {
    const raw = tamarindRaw();
    delete (raw.toolMap as Record<string, unknown>).estimate;
    const result = parseProviderManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/toolMap\.estimate/);
  });

  it('static catalogs must list tools; dynamic catalogs must not', () => {
    const raw = tamarindRaw();
    raw.catalog = 'static';
    expect(parseProviderManifest(raw).ok).toBe(false);

    const nvidia = clone(
      BUNDLED_MANIFESTS.find((m) => (m as { id: string }).id === 'nvidia-nim') as Record<
        string,
        unknown
      >
    );
    nvidia.catalog = 'dynamic';
    const result = parseProviderManifest(nvidia);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/dynamic catalogs must not/);
  });

  it('disclosure must name the provider and say who is billed', () => {
    const raw = tamarindRaw();
    raw.disclosure =
      'Your data goes to a third party. Please read the terms before connecting to it.';
    const result = parseProviderManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/disclosure/);
  });

  it('rejects a toolMap argument bound to an unknown placeholder', () => {
    const raw = tamarindRaw();
    (raw.toolMap as Record<string, unknown>).submit = {
      tool: 'submitJob',
      args: { jobName: '$nope' },
    };
    const result = parseProviderManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/toolMap\.submit/);
  });

  it('rejects a statusMap value outside the job-state vocabulary', () => {
    const raw = tamarindRaw();
    (raw.statusMap as Record<string, string>).weird = 'exploded';
    expect(parseProviderManifest(raw).ok).toBe(false);
  });

  it('rejects an unknown transport', () => {
    const raw = tamarindRaw();
    raw.transport = 'grpc';
    expect(parseProviderManifest(raw).ok).toBe(false);
  });

  it('requires a known transport-compatible driver in schema v2', () => {
    const nvidia = clone(
      BUNDLED_MANIFESTS.find((m) => (m as { id: string }).id === 'nvidia-nim') as Record<
        string,
        unknown
      >
    );
    nvidia.driver = { kind: 'made-up' };
    const unknown = parseProviderManifest(nvidia);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.join('\n')).toMatch(/driver/);

    nvidia.driver = { kind: 'mcp-tool-map' };
    const mismatch = parseProviderManifest(nvidia);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.errors.join('\n')).toMatch(/transport/);
  });

  it('keeps v1 manifests compatible while v2 NVCF tools own their schemas', () => {
    const byId = Object.fromEntries(
      loadBundledManifests().map((manifest) => [manifest.id, manifest])
    );
    expect(effectiveDriverKind(byId.tamarind)).toBe('mcp-tool-map');
    expect(effectiveDriverKind(byId.boltz)).toBe('legacy-rest');

    const nvidia = byId['nvidia-nim'];
    expect(nvidia.schemaVersion).toBe(2);
    expect(nvidia.staticTools?.every((tool) => tool.inputSchema)).toBe(true);
  });

  it('accepts a constrained declarative HTTP job lifecycle and rejects unsafe placeholders', () => {
    const raw = clone(
      BUNDLED_MANIFESTS.find((m) => (m as { id: string }).id === 'nvidia-nim') as Record<
        string,
        unknown
      >
    );
    raw.jobModel = 'async';
    raw.cancellation = { mode: 'provider', note: 'The remote API accepts cancellation.' };
    raw.driver = {
      kind: 'http-job',
      submit: { method: 'POST', idPath: 'id', bodyTemplate: { input: '$settings' } },
      status: {
        method: 'GET',
        pathTemplate: '/jobs/{remote_id}',
        statePath: 'status',
        statusMap: { queued: 'queued', done: 'completed', failed: 'failed' },
      },
      result: { payloadPath: 'output', codec: 'raw-json' },
      cancel: { method: 'POST', pathTemplate: '/jobs/{remote_id}/cancel' },
    };
    expect(parseProviderManifest(raw).ok).toBe(true);

    ((raw.driver as Record<string, unknown>).submit as Record<string, unknown>).bodyTemplate = {
      input: '$environment.SECRET',
    };
    const unsafe = parseProviderManifest(raw);
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.errors.join('\n')).toMatch(/placeholder/);
  });

  it('keeps every authenticated REST target on the declared base origin', () => {
    const raw = clone(
      BUNDLED_MANIFESTS.find((m) => (m as { id: string }).id === 'replicate') as Record<
        string,
        unknown
      >
    );

    (raw.verify as Record<string, unknown>).target = 'https://attacker.example/account';
    expect(parseProviderManifest(raw).ok).toBe(false);

    (raw.verify as Record<string, unknown>).target = '/account';
    ((raw.staticTools as Record<string, unknown>[])[0] as Record<string, unknown>).path =
      '//attacker.example/predictions';
    expect(parseProviderManifest(raw).ok).toBe(false);

    ((raw.staticTools as Record<string, unknown>[])[0] as Record<string, unknown>).path =
      '/predictions';
    const driver = raw.driver as Record<string, Record<string, unknown>>;
    driver.status.pathTemplate = 'https://attacker.example/{remote_id}';
    expect(parseProviderManifest(raw).ok).toBe(false);
  });

  it('allows only inert request headers in declarative HTTP jobs', () => {
    const raw = clone(
      BUNDLED_MANIFESTS.find((m) => (m as { id: string }).id === 'replicate') as Record<
        string,
        unknown
      >
    );
    const submit = (raw.driver as Record<string, Record<string, unknown>>).submit;
    submit.headers = { Authorization: 'Bearer manifest-owned-secret' };
    expect(parseProviderManifest(raw).ok).toBe(false);

    submit.headers = { Prefer: 'wait=5' };
    expect(parseProviderManifest(raw).ok).toBe(true);
  });

  it('accepts only the bounded JSON-Schema subset the sidecar actually evaluates', () => {
    const raw = clone(
      BUNDLED_MANIFESTS.find((m) => (m as { id: string }).id === 'replicate') as Record<
        string,
        unknown
      >
    );
    const schema = (raw.staticTools as Array<{ inputSchema: Record<string, unknown> }>)[0]
      .inputSchema;
    const version = (schema.properties as Record<string, Record<string, unknown>>).version;

    version.pattern = '^(a+)+$';
    const unsafePattern = parseProviderManifest(raw);
    expect(unsafePattern.ok).toBe(false);
    if (!unsafePattern.ok)
      expect(unsafePattern.errors.join('\n')).toMatch(/simple character-class/);

    delete version.pattern;
    version.$ref = 'https://attacker.example/schema.json';
    const unsupportedKeyword = parseProviderManifest(raw);
    expect(unsupportedKeyword.ok).toBe(false);
    if (!unsupportedKeyword.ok) expect(unsupportedKeyword.errors.join('\n')).toMatch(/supported/);
  });
});

describe('computeCredentialAccount', () => {
  it('derives the keychain account from the provider id', () => {
    expect(computeCredentialAccount('tamarind')).toBe('tamarind_compute_key');
    expect(computeCredentialAccount('nvidia-nim')).toBe('nvidia-nim_compute_key');
  });
  it('refuses ids that fail the manifest pattern', () => {
    expect(() => computeCredentialAccount('Tamarind')).toThrow(/invalid provider id/);
    expect(() => computeCredentialAccount('../etc')).toThrow();
  });
});
