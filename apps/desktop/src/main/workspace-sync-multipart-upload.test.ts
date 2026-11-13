import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  uploadWorkspaceMultipart,
  type WorkspaceMultipartControl,
  type WorkspaceMultipartSession,
  type WorkspaceMultipartUploadedPart,
} from './workspace-sync-multipart-upload';

const PART_BYTES = 16 * 1024 ** 2;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(size = 129) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-multipart-'));
  roots.push(root);
  const bytes = Buffer.alloc(size, 43);
  const filePath = join(root, 'frozen.bin');
  await writeFile(filePath, bytes);
  await chmod(filePath, 0o444);
  const session: WorkspaceMultipartSession = {
    reservationId: randomUUID(),
    generation: randomUUID(),
    uploadId: 'opaque-provider-upload',
    providerOrigin: 'http://127.0.0.1',
  };
  const input = {
    accountId: randomUUID(),
    filePath,
    sizeBytes: size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    resumeStatePath: join(root, 'outbox'),
    session,
    assertAccount: vi.fn(async () => {}),
  };
  const statePath = `${input.resumeStatePath}.${session.reservationId}.${session.generation}.multipart.json`;
  return { bytes, input, statePath };
}

async function provider(input: Awaited<ReturnType<typeof fixture>>['input']) {
  const parts = new Map<number, { bytes: Buffer; receipt: WorkspaceMultipartUploadedPart }>();
  const attempts = new Map<number, number>();
  const headers: Record<string, string | string[] | undefined>[] = [];
  let completed = false;
  let held: ServerResponse | undefined;
  let interrupt = false;
  let announcePartTwo: () => void = () => {};
  const partTwoReceived = new Promise<void>((resolve) => {
    announcePartTwo = resolve;
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', input.session.providerOrigin);
    const number = Number(url.searchParams.get('partNumber'));
    headers.push(request.headers);
    attempts.set(number, (attempts.get(number) ?? 0) + 1);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
    } catch {
      response.destroy();
      return;
    }
    const bytes = Buffer.concat(chunks);
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    parts.set(number, { bytes, receipt: { partNumber: number, sizeBytes: bytes.length, etag } });
    if (interrupt && number === 2) {
      held = response;
      announcePartTwo();
      return;
    }
    if (interrupt && number === 1) await partTwoReceived;
    response.writeHead(200, { etag });
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener address.');
  input.session.providerOrigin = `http://127.0.0.1:${address.port}`;
  const control: WorkspaceMultipartControl = {
    inspect: vi.fn(async () => ({
      completed,
      parts: [...parts.values()].map((part) => part.receipt),
    })),
    signPart: vi.fn(async (_session, number) => {
      if (interrupt && number === 3) {
        interrupt = false;
        if (!held) throw new Error('Part two was not received before part three.');
        held.destroy();
        throw new Error('Controlled network interruption.');
      }
      const url = new URL(
        `/storage/v1/s3/workspace-snapshots/desktop-sync/multipart/${input.session.reservationId}/${input.session.generation}.bin`,
        input.session.providerOrigin
      );
      url.searchParams.set('uploadId', input.session.uploadId);
      url.searchParams.set('partNumber', String(number));
      url.searchParams.set('X-Amz-Signature', 'part-only-signature');
      return {
        partNumber: number,
        sizeBytes: Math.min(PART_BYTES, input.sizeBytes - (number - 1) * PART_BYTES),
        url: url.href,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    }),
    complete: vi.fn(async () => {
      const reconstructed = Buffer.concat(
        [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part.bytes)
      );
      expect(reconstructed.length).toBe(input.sizeBytes);
      expect(createHash('sha256').update(reconstructed).digest('hex')).toBe(input.sha256);
      completed = true;
    }),
  };
  return {
    parts,
    attempts,
    headers,
    control,
    interrupt: () => {
      interrupt = true;
    },
  };
}

describe('native persisted multipart transfer', () => {
  it('resumes acknowledged bytes from disk after interruption, safely resends an unacknowledged remote part and completes read-only sources', async () => {
    const { input, statePath } = await fixture(PART_BYTES * 2 + 129);
    const remote = await provider(input);
    remote.interrupt();
    await expect(uploadWorkspaceMultipart({ ...input, control: remote.control })).rejects.toThrow();
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    expect(saved.parts.map((part: WorkspaceMultipartUploadedPart) => part.partNumber)).toEqual([1]);
    expect(saved.completed).toBe(false);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(saved)).not.toContain('X-Amz');
    expect(JSON.stringify(saved)).not.toContain('part-only-signature');
    expect(remote.parts.has(2)).toBe(true);
    await uploadWorkspaceMultipart({ ...input, control: remote.control });
    expect(remote.attempts.get(1)).toBe(1);
    expect(remote.attempts.get(2)).toBe(2);
    expect(remote.attempts.get(3)).toBe(1);
    expect(remote.control.complete).toHaveBeenCalledTimes(1);
    await uploadWorkspaceMultipart({ ...input, control: remote.control });
    expect(remote.control.complete).toHaveBeenCalledTimes(1);
    expect(remote.attempts.get(1)).toBe(1);
    expect(remote.headers.every((headers) => !headers.authorization && !headers.cookie)).toBe(true);
    expect(JSON.parse(await readFile(statePath, 'utf8')).completed).toBe(true);
  });

  it('refuses a mutated acknowledged provider part without uploading or completing again', async () => {
    const { input } = await fixture();
    const remote = await provider(input);
    await uploadWorkspaceMultipart({ ...input, control: remote.control });
    const part = remote.parts.get(1);
    if (!part) throw new Error('Missing accepted part.');
    part.receipt.etag = 'changed-by-another-writer';
    await expect(uploadWorkspaceMultipart({ ...input, control: remote.control })).rejects.toThrow(
      'changed remotely'
    );
    expect(remote.attempts.get(1)).toBe(1);
    expect(remote.control.complete).toHaveBeenCalledTimes(1);
  });

  it('refuses another account or changed source before obtaining fresh upload authority', async () => {
    const { input } = await fixture();
    const remote = await provider(input);
    await uploadWorkspaceMultipart({ ...input, control: remote.control });
    await expect(
      uploadWorkspaceMultipart({ ...input, accountId: randomUUID(), control: remote.control })
    ).rejects.toThrow('another source, account or upload');
    await chmod(input.filePath, 0o600);
    await writeFile(input.filePath, Buffer.alloc(input.sizeBytes, 44));
    await expect(uploadWorkspaceMultipart({ ...input, control: remote.control })).rejects.toThrow(
      'changed before transfer'
    );
    expect(remote.control.inspect).toHaveBeenCalledTimes(1);
    expect(remote.attempts.get(1)).toBe(1);
  });

  it.each(['session-token', 'different-object', 'expired'] as const)(
    'refuses %s capabilities before any provider request',
    async (kind) => {
      const { input } = await fixture();
      const remote = await provider(input);
      const original = remote.control.signPart;
      remote.control.signPart = async (...args) => {
        const capability = await original(...args);
        const url = new URL(capability.url);
        if (kind === 'session-token')
          url.searchParams.set('X-Amz-Security-Token', 'forbidden-provider-credential');
        if (kind === 'different-object')
          url.pathname = '/storage/v1/s3/workspace-snapshots/accepted-cas.bin';
        return {
          ...capability,
          url: url.href,
          expiresAt: kind === 'expired' ? new Date(0).toISOString() : capability.expiresAt,
        };
      };
      await expect(uploadWorkspaceMultipart({ ...input, control: remote.control })).rejects.toThrow(
        'does not match'
      );
      expect(remote.attempts.size).toBe(0);
      expect(remote.control.complete).not.toHaveBeenCalled();
    }
  );
});
