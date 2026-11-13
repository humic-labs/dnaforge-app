import { afterEach, describe, expect, it, vi } from 'vitest';

const originalToken = process.env.DNAFORGE_MCP_SESSION_TOKEN;
const originalGeneration = process.env.DNAFORGE_SIDECAR_SESSION_GENERATION;
const originalHumanToken = process.env.DNAFORGE_HUMAN_OPERATION_TOKEN;
const originalNativeToken = process.env.DNAFORGE_NATIVE_DOCUMENT_TOKEN;
const originalNativeOwnerId = process.env.DNAFORGE_NATIVE_DOCUMENT_OWNER_ID;
const originalNativeUrl = process.env.DNAFORGE_NATIVE_DOCUMENT_URL;

afterEach(() => {
  if (originalToken === undefined) delete process.env.DNAFORGE_MCP_SESSION_TOKEN;
  else process.env.DNAFORGE_MCP_SESSION_TOKEN = originalToken;

  if (originalGeneration === undefined) delete process.env.DNAFORGE_SIDECAR_SESSION_GENERATION;
  else process.env.DNAFORGE_SIDECAR_SESSION_GENERATION = originalGeneration;
  if (originalHumanToken === undefined) delete process.env.DNAFORGE_HUMAN_OPERATION_TOKEN;
  else process.env.DNAFORGE_HUMAN_OPERATION_TOKEN = originalHumanToken;
  if (originalNativeToken === undefined) delete process.env.DNAFORGE_NATIVE_DOCUMENT_TOKEN;
  else process.env.DNAFORGE_NATIVE_DOCUMENT_TOKEN = originalNativeToken;
  if (originalNativeOwnerId === undefined) delete process.env.DNAFORGE_NATIVE_DOCUMENT_OWNER_ID;
  else process.env.DNAFORGE_NATIVE_DOCUMENT_OWNER_ID = originalNativeOwnerId;
  if (originalNativeUrl === undefined) delete process.env.DNAFORGE_NATIVE_DOCUMENT_URL;
  else process.env.DNAFORGE_NATIVE_DOCUMENT_URL = originalNativeUrl;

  vi.resetModules();
});

describe('sidecar session runtime credential boundary', () => {
  it('captures an external bootstrap token without leaving it ambient for child processes', async () => {
    process.env.DNAFORGE_MCP_SESSION_TOKEN = 'external-bootstrap-token';
    process.env.DNAFORGE_SIDECAR_SESSION_GENERATION = '41';
    process.env.DNAFORGE_HUMAN_OPERATION_TOKEN = 'external-human-operation-token';
    process.env.DNAFORGE_NATIVE_DOCUMENT_TOKEN = 'external-native-document-token';
    process.env.DNAFORGE_NATIVE_DOCUMENT_OWNER_ID = 'external-native-owner';
    process.env.DNAFORGE_NATIVE_DOCUMENT_URL = 'http://127.0.0.1:12345';

    const { prepareSidecarSpawn, sidecarSessionAuthority } =
      await import('./sidecar-session-runtime');

    expect(sidecarSessionAuthority.snapshot()).toMatchObject({
      owner: 'external',
      token: 'external-bootstrap-token',
    });
    expect(process.env.DNAFORGE_MCP_SESSION_TOKEN).toBeUndefined();
    expect(process.env.DNAFORGE_SIDECAR_SESSION_GENERATION).toBeUndefined();
    expect(process.env.DNAFORGE_HUMAN_OPERATION_TOKEN).toBeUndefined();
    expect(process.env.DNAFORGE_NATIVE_DOCUMENT_TOKEN).toBeUndefined();
    expect(process.env.DNAFORGE_NATIVE_DOCUMENT_OWNER_ID).toBeUndefined();
    expect(process.env.DNAFORGE_NATIVE_DOCUMENT_URL).toBeUndefined();

    const spawn = prepareSidecarSpawn('initial');
    expect(spawn).toMatchObject({
      owner: 'external',
      generation: 1,
      token: 'external-bootstrap-token',
    });
    expect(process.env.DNAFORGE_MCP_SESSION_TOKEN).toBeUndefined();
    expect(process.env.DNAFORGE_SIDECAR_SESSION_GENERATION).toBeUndefined();
    expect(sidecarSessionAuthority.humanOperationToken(spawn)).toBe(
      'external-human-operation-token'
    );
    expect(sidecarSessionAuthority.nativeDocumentAuthority(spawn)).toEqual({
      token: 'external-native-document-token',
      ownerInstanceId: 'external-native-owner',
    });
  });

  it('passes only an explicitly registered native endpoint to the same owner across sidecar restarts', async () => {
    delete process.env.DNAFORGE_MCP_SESSION_TOKEN;
    const runtime = await import('./sidecar-session-runtime');
    const initial = runtime.sidecarSessionAuthority.snapshot();
    const authority = runtime.sidecarSessionAuthority.nativeDocumentAuthority(initial);
    if (!authority) throw new Error('Missing native owner');
    expect(runtime.nativeDocumentCommandEnv(initial)).toEqual({});
    expect(() =>
      runtime.registerNativeDocumentCommandServer('http://127.0.0.1:12345', 'another-owner')
    ).toThrow(/owner/i);
    const detach = runtime.registerNativeDocumentCommandServer(
      'http://127.0.0.1:12345',
      authority.ownerInstanceId
    );
    expect(runtime.nativeDocumentCommandEnv(initial)).toEqual({
      DNAFORGE_NATIVE_DOCUMENT_URL: 'http://127.0.0.1:12345',
    });
    expect(() =>
      runtime.registerNativeDocumentCommandServer(
        'http://127.0.0.1:23456',
        authority.ownerInstanceId
      )
    ).toThrow(/already/i);
    const restarted = runtime.prepareSidecarSpawn('respawn');
    expect(runtime.sidecarSessionAuthority.nativeDocumentAuthority(restarted)?.token).not.toBe(
      authority.token
    );
    expect(runtime.nativeDocumentCommandEnv(restarted)).toEqual({
      DNAFORGE_NATIVE_DOCUMENT_URL: 'http://127.0.0.1:12345',
    });
    expect(() => runtime.nativeDocumentCommandEnv(initial)).toThrow(/session/i);
    detach();
    const detachReplacement = runtime.registerNativeDocumentCommandServer(
      'http://127.0.0.1:23456',
      authority.ownerInstanceId
    );
    detach();
    expect(runtime.nativeDocumentCommandEnv(restarted)).toEqual({
      DNAFORGE_NATIVE_DOCUMENT_URL: 'http://127.0.0.1:23456',
    });
    detachReplacement();
    expect(runtime.nativeDocumentCommandEnv(restarted)).toEqual({});
    expect(process.env.DNAFORGE_NATIVE_DOCUMENT_URL).toBeUndefined();
  });

  it.each([
    'http://localhost:12345',
    'https://127.0.0.1:12345',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:12345/path',
    'http://secret@127.0.0.1:12345',
    'http://127.0.0.1:12345?redirect=yes',
  ])('refuses an unsupported native endpoint %s', async (url) => {
    delete process.env.DNAFORGE_MCP_SESSION_TOKEN;
    const runtime = await import('./sidecar-session-runtime');
    const snapshot = runtime.sidecarSessionAuthority.snapshot();
    const authority = runtime.sidecarSessionAuthority.nativeDocumentAuthority(snapshot);
    if (!authority) throw new Error('Missing native owner');
    expect(() =>
      runtime.registerNativeDocumentCommandServer(url, authority.ownerInstanceId)
    ).toThrow(/loopback/i);
    expect(runtime.nativeDocumentCommandEnv(snapshot)).toEqual({});
  });
});
