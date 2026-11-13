import { describe, expect, it } from 'vitest';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import { readScientificDocumentInMain, resolveMainWorkspaceIdentity } from './scientific-documents';

const request = {
  operationId: 'read-1',
  workspaceRoot: '/workspace',
  workspace: parseWorkspaceIdentity('workspace:1'),
  document: parseScientificDocumentIdentity('sequences/pUC19.gb'),
};
const canonicalize = async () => ({
  root: '/workspace',
  candidate: '/workspace/sequences/pUC19.gb',
  parent: '/workspace/sequences',
});

describe('desktop scientific document main boundary', () => {
  it('binds a local root to the stable workspace identity in main', () => {
    const database = {
      prepare: () => ({
        get: (value: string) =>
          value === '/workspace' ? { id: 7, repo_uuid: 'managed-workspace' } : undefined,
      }),
    };
    expect(resolveMainWorkspaceIdentity('/workspace', database)).toBe('managed-workspace');
    expect(resolveMainWorkspaceIdentity('/missing', database)).toBeNull();
  });

  it('returns the exact UTF-8 content with a stable revision', async () => {
    const result = await readScientificDocumentInMain(request, {
      read: async () => Buffer.from('LOCUS pUC19 2686 bp\n//\n'),
      canonicalize,
    });
    expect(result).toMatchObject({
      ok: true,
      document: {
        workspace: 'workspace:1',
        document: 'sequences/pUC19.gb',
        format: 'genbank',
        support: { route: 'desktop', access: 'read-write' },
      },
    });
  });

  it('denies traversal before filesystem access', async () => {
    const read = async () => Buffer.from('unreachable');
    const result = await readScientificDocumentInMain(
      { ...request, document: '../secret.gb' as typeof request.document },
      { read, canonicalize }
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_DOCUMENT_IDENTITY' } });
  });

  it('maps invalid UTF-8 and cancellation to domain errors', async () => {
    const invalid = await readScientificDocumentInMain(request, {
      read: async () => Buffer.from([0xc3, 0x28]),
      canonicalize,
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_ENCODING' } });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await readScientificDocumentInMain(request, {
      signal: controller.signal,
      canonicalize,
      read: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });
});
