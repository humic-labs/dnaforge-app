// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureWorkspaceSyncBlob } from './workspace-sync-blob-cache';
import {
  parseWorkspaceSyncDirectUpload,
  uploadWorkspaceSyncFileDirect,
  type WorkspaceSyncDirectUpload,
} from './workspace-sync-direct-upload';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('direct-storage TUS transfer', () => {
  it('accepts the signed endpoint returned by the real reservation API', () => {
    const reservation = {
      protocol: 'tus',
      endpoint: 'https://fixture.storage.supabase.co/storage/v1/upload/resumable/sign',
      token: 'signed-object-capability',
      bucket: 'workspace-snapshots',
      path: 'desktop-sync/cas/org/owner/library.bin',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      upsert: false,
    };
    expect(parseWorkspaceSyncDirectUpload(reservation)).toEqual(reservation);
    expect(() =>
      parseWorkspaceSyncDirectUpload({
        ...reservation,
        endpoint: reservation.endpoint.replace('/sign', ''),
      })
    ).toThrow('Invalid direct upload reservation.');
  });
  it('preserves an account-change error and sends no bytes after the account fence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sync-account-'));
    roots.push(root);
    const accountError = Object.assign(new Error('Account changed.'), { code: 'ACCOUNT_CHANGED' });
    const fetch = vi.fn();
    const file = {
      id: 'file',
      relativePath: 'library.gb',
      name: 'library.gb',
      kind: 'genbank' as const,
      contentType: 'text/plain',
      content: 'test',
      sizeBytes: 4,
      sha256: createHash('sha256').update('test').digest('hex'),
    };
    const capability: WorkspaceSyncDirectUpload = {
      protocol: 'tus',
      endpoint: 'https://fixture.storage.supabase.co/storage/v1/upload/resumable/sign',
      token: 'cap',
      bucket: 'workspace-snapshots',
      path: 'owner/file.bin',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      upsert: false,
    };
    await expect(
      uploadWorkspaceSyncFileDirect(file, capability, 'account-fence', {
        cacheRoot: root,
        fetch,
        assertAccount: async () => {
          throw accountError;
        },
      })
    ).rejects.toBe(accountError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['https', 'loopback'] as const)(
    'resumes accepted bytes through %s after interruption, with bounded chunks and no bearer token',
    async (transport) => {
      const root = await mkdtemp(join(tmpdir(), 'sync-tus-'));
      roots.push(root);
      const bytes = Buffer.alloc(13 * 1024 * 1024, 81);
      const source = join(root, 'library.gb');
      await writeFile(source, bytes);
      const identity = await captureWorkspaceSyncBlob(source, {
        maxBytes: bytes.length,
        cacheRoot: root,
      });
      const expected = createHash('sha256').update(bytes).digest('hex');
      let offset = 0;
      let largestChunk = 0;
      let creates = 0;
      let heads = 0;
      const hash = createHash('sha256');
      const headers: (string | undefined)[] = [];
      const interrupted = new AbortController();
      let cutConnection = true;
      let remote = 'https://fixture.storage.supabase.co/storage/v1/upload/resumable/sign';
      const server = createServer(async (req, res) => {
        headers.push(req.headers.authorization);
        res.setHeader('Tus-Resumable', '1.0.0');
        if (req.method === 'POST') {
          creates += 1;
          res.writeHead(201, { Location: `${remote}/transfer-1` });
          res.end();
          return;
        }
        if (req.method === 'HEAD') {
          heads += 1;
          res.writeHead(200, {
            'Upload-Offset': String(offset),
            'Upload-Length': String(bytes.length),
          });
          res.end();
          return;
        }
        if (req.method !== 'PATCH' || Number(req.headers['upload-offset']) !== offset) {
          res.writeHead(409);
          res.end();
          return;
        }
        let size = 0;
        for await (const chunk of req) {
          hash.update(chunk);
          size += chunk.length;
        }
        largestChunk = Math.max(largestChunk, size);
        offset += size;
        if (cutConnection) {
          cutConnection = false;
          interrupted.abort(new Error('simulated process interruption'));
          res.destroy();
          return;
        }
        res.writeHead(204, { 'Upload-Offset': String(offset) });
        res.end();
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server port.');
      if (transport === 'loopback')
        remote = `http://127.0.0.1:${address.port}/storage/v1/upload/resumable/sign`;
      const transferFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        url.protocol = 'http:';
        url.hostname = '127.0.0.1';
        url.port = String(address.port);
        return fetch(url, init);
      };
      const capability: WorkspaceSyncDirectUpload = {
        protocol: 'tus',
        endpoint: remote,
        token: 'signed-object-capability',
        bucket: 'workspace-snapshots',
        path: 'owner/library.bin',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        upsert: false,
      };
      const file = {
        ...identity,
        id: 'large',
        relativePath: 'library.gb',
        name: 'library.gb',
        kind: 'genbank' as const,
        contentType: 'text/plain',
        content: '',
        encoding: 'blob' as const,
      };
      await expect(
        uploadWorkspaceSyncFileDirect(file, capability, 'account:workspace:reservation:digest', {
          cacheRoot: root,
          fetch: transferFetch,
          signal: interrupted.signal,
        })
      ).rejects.toThrow();
      expect(offset).toBe(6 * 1024 * 1024);
      await uploadWorkspaceSyncFileDirect(
        file,
        capability,
        'account:workspace:reservation:digest',
        {
          cacheRoot: root,
          fetch: transferFetch,
        }
      );
      expect({ offset, creates, heads }).toEqual({ offset: bytes.length, creates: 1, heads: 1 });
      expect(largestChunk).toBeLessThanOrEqual(6 * 1024 * 1024);
      expect(hash.digest('hex')).toBe(expected);
      expect(headers.every((value) => value === undefined)).toBe(true);
    },
    20_000
  );
});
