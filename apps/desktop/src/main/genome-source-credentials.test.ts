import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ handle: vi.fn() }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/dnaforge-credential-test' },
  ipcMain: { handle: h.handle },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

import { GENOME_SOURCE_CREDENTIAL_V1 } from '../shared/genome-source-credentials';
import { createGenomeSourceCredentialHandlers } from './genome-source-credentials';

const CANARY = 'INERT_MAIN_CREDENTIAL_CANARY_987654';

describe('genome source credential handlers', () => {
  const stored = new Map<string, string>();
  const sidecarCalls: Array<{ path: string; body: unknown }> = [];

  beforeEach(() => {
    stored.clear();
    sidecarCalls.length = 0;
  });

  function handlers(response?: Response) {
    return createGenomeSourceCredentialHandlers({
      hasStored: async (service, account) => stored.has(`${service}:${account}`),
      readStored: async (service, account) => stored.get(`${service}:${account}`) ?? null,
      writeStored: async (service, account, value) => {
        stored.set(`${service}:${account}`, value);
      },
      deleteStored: async (service, account) => {
        stored.delete(`${service}:${account}`);
      },
      sidecarFetch: async (path, init) => {
        sidecarCalls.push({
          path: String(path),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return (
          response ??
          new Response(JSON.stringify({ auth_ref: 'source:private', kind: 'http-bearer' }), {
            status: 200,
          })
        );
      },
    });
  }

  it('stores long-lived material, returns only a summary, and brokers it on prepare', async () => {
    const subject = handlers();
    const summary = await subject.save({
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:private',
      kind: 'http-bearer',
      token: CANARY,
    });

    expect(summary).toEqual({
      authRef: 'source:private',
      kind: 'http-bearer',
      connected: true,
    });
    expect(JSON.stringify(summary)).not.toContain(CANARY);
    expect(await subject.status('source:private')).toEqual({
      authRef: 'source:private',
      connected: true,
    });

    const receipt = await subject.prepare('source:private');
    expect(receipt).toEqual(summary);
    expect(JSON.stringify(receipt)).not.toContain(CANARY);
    expect(sidecarCalls).toEqual([
      {
        path: '/external/credential-broker/register',
        body: {
          auth_ref: 'source:private',
          kind: 'http-bearer',
          material: { token: CANARY },
        },
      },
    ]);

    const serialized = [...stored.values()][0];
    expect(serialized).toContain(CANARY);
    expect([...stored.keys()][0]).not.toContain('source:private');
  });

  it('does not echo stored material through broker failures', async () => {
    const subject = handlers(new Response(`upstream rejected ${CANARY}`, { status: 401 }));
    await subject.save({
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:private',
      kind: 'http-bearer',
      token: CANARY,
    });

    const error = await subject.prepare('source:private').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('HTTP 401');
    expect(String(error)).not.toContain(CANARY);
  });

  it('removes keyring and process-broker state without reading the secret', async () => {
    const subject = handlers();
    await subject.save({
      contract: GENOME_SOURCE_CREDENTIAL_V1,
      authRef: 'source:private',
      kind: 'gcs-oauth',
      accessToken: CANARY,
    });

    expect(await subject.remove('source:private')).toEqual({
      authRef: 'source:private',
      removed: true,
    });
    expect(await subject.status('source:private')).toEqual({
      authRef: 'source:private',
      connected: false,
    });
    expect(sidecarCalls).toEqual([
      {
        path: '/external/credential-broker/remove',
        body: { auth_ref: 'source:private' },
      },
    ]);
  });
});
