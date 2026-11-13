import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, mkdir, rename, type FileHandle } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { syncDirectory } from './fs-durability';
import { createKeyedMutex } from './workspace-git/keyed-mutex';

const PART_BYTES = 16 * 1024 ** 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const withUpload = createKeyedMutex();

export interface WorkspaceMultipartSession {
  reservationId: string;
  generation: string;
  uploadId: string;
  providerOrigin: string;
}
export interface WorkspaceMultipartUploadedPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}
export interface WorkspaceMultipartPartCapability {
  partNumber: number;
  sizeBytes: number;
  url: string;
  expiresAt: string;
}
export interface WorkspaceMultipartControl {
  inspect(
    session: WorkspaceMultipartSession,
    signal?: AbortSignal
  ): Promise<{
    completed: boolean;
    parts: WorkspaceMultipartUploadedPart[];
  }>;
  signPart(
    session: WorkspaceMultipartSession,
    partNumber: number,
    signal?: AbortSignal
  ): Promise<WorkspaceMultipartPartCapability>;
  complete(session: WorkspaceMultipartSession, signal?: AbortSignal): Promise<void>;
}
interface LocalState {
  schema: 'workspace-sync-multipart-native.v1';
  accountId: string;
  session: WorkspaceMultipartSession;
  sizeBytes: number;
  sha256: string;
  parts: WorkspaceMultipartUploadedPart[];
  completed: boolean;
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'BAD_BUNDLE', retryable: false });
}
function safeOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('Multipart provider origin is invalid.');
  }
  const local =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const hosted =
    url.protocol === 'https:' && /^[a-z0-9]+\.storage\.supabase\.co$/.test(url.hostname);
  if (
    (!local && !hosted) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw invalid('Multipart provider origin is invalid.');
  }
  return url;
}
function objectPath(session: WorkspaceMultipartSession): string {
  if (
    !UUID.test(session.reservationId) ||
    !UUID.test(session.generation) ||
    typeof session.uploadId !== 'string' ||
    !session.uploadId ||
    session.uploadId.length > 1024
  ) {
    throw invalid('Multipart upload identity is invalid.');
  }
  return `/storage/v1/s3/workspace-snapshots/desktop-sync/multipart/${session.reservationId}/${session.generation}.bin`;
}
function partSize(size: number, number: number): number {
  if (!Number.isSafeInteger(number) || number < 1 || number > Math.ceil(size / PART_BYTES)) {
    throw invalid('Multipart provider returned an invalid part number.');
  }
  return Math.min(PART_BYTES, size - (number - 1) * PART_BYTES);
}
function validatePart(part: WorkspaceMultipartUploadedPart, size: number): void {
  if (
    !part ||
    part.sizeBytes !== partSize(size, part.partNumber) ||
    typeof part.etag !== 'string' ||
    !part.etag ||
    part.etag.length > 512 ||
    Array.from(part.etag).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    throw invalid('Multipart provider returned an invalid part receipt.');
  }
}
async function hashSource(file: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of readRange(file, 0, size)) hash.update(bytes);
  return hash.digest('hex');
}
async function* readRange(file: FileHandle, start: number, size: number): AsyncGenerator<Buffer> {
  let position = start;
  const end = start + size;
  while (position < end) {
    const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, end - position));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw invalid('Multipart source ended before its expected length.');
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
async function saveState(path: string, state: LocalState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
async function readState(path: string, expected: LocalState): Promise<LocalState> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return expected;
    throw invalid('Saved multipart upload state is unreadable.');
  }
  if (!value || typeof value !== 'object')
    throw invalid('Saved multipart upload state is invalid.');
  const record = value as Record<string, unknown>;
  const session =
    record.session && typeof record.session === 'object'
      ? (record.session as Record<string, unknown>)
      : null;
  if (
    record.schema !== expected.schema ||
    record.accountId !== expected.accountId ||
    record.sha256 !== expected.sha256 ||
    record.sizeBytes !== expected.sizeBytes ||
    typeof record.completed !== 'boolean' ||
    !Array.isArray(record.parts) ||
    !session ||
    session.reservationId !== expected.session.reservationId ||
    session.generation !== expected.session.generation ||
    session.uploadId !== expected.session.uploadId ||
    session.providerOrigin !== expected.session.providerOrigin
  ) {
    throw invalid('Saved multipart upload state belongs to another source, account or upload.');
  }
  const parts: WorkspaceMultipartUploadedPart[] = [];
  for (const value of record.parts) {
    if (!value || typeof value !== 'object') throw invalid('Saved multipart part is invalid.');
    const row = value as Record<string, unknown>;
    if (
      typeof row.partNumber !== 'number' ||
      typeof row.sizeBytes !== 'number' ||
      typeof row.etag !== 'string'
    ) {
      throw invalid('Saved multipart part is invalid.');
    }
    const part = { partNumber: row.partNumber, sizeBytes: row.sizeBytes, etag: row.etag };
    validatePart(part, expected.sizeBytes);
    if (parts.some((stored) => stored.partNumber === part.partNumber))
      throw invalid('Saved multipart parts are duplicated.');
    parts.push(part);
  }
  return { ...expected, parts, completed: record.completed };
}

async function sendPart(
  file: FileHandle,
  capability: WorkspaceMultipartPartCapability,
  session: WorkspaceMultipartSession,
  size: number,
  signal: AbortSignal
): Promise<string> {
  let url: URL;
  try {
    url = new URL(capability.url);
  } catch {
    throw invalid('Multipart part capability is invalid.');
  }
  if (
    url.origin !== safeOrigin(session.providerOrigin).origin ||
    decodeURIComponent(url.pathname) !== objectPath(session) ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.get('uploadId') !== session.uploadId ||
    url.searchParams.get('partNumber') !== String(capability.partNumber) ||
    [...url.searchParams.keys()].some((key) => key.toLowerCase() === 'x-amz-security-token') ||
    capability.sizeBytes !== partSize(size, capability.partNumber) ||
    !Number.isFinite(Date.parse(capability.expiresAt)) ||
    Date.parse(capability.expiresAt) <= Date.now()
  ) {
    throw invalid('Multipart part capability does not match its upload.');
  }
  const start = (capability.partNumber - 1) * PART_BYTES;
  const body = Readable.from(readRange(file, start, capability.sizeBytes));
  try {
    return await new Promise<string>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        { method: 'PUT', signal, headers: { 'content-length': String(capability.sizeBytes) } },
        (response) => {
          response.resume();
          response.once('error', () =>
            reject(
              Object.assign(new Error('Multipart upload response failed.'), {
                code: 'NETWORK',
                retryable: true,
              })
            )
          );
          response.once('aborted', () =>
            reject(
              Object.assign(new Error('Multipart upload response was interrupted.'), {
                code: 'NETWORK',
                retryable: true,
              })
            )
          );
          response.once('end', () => {
            if (
              response.statusCode &&
              response.statusCode >= 200 &&
              response.statusCode < 300 &&
              response.headers.etag
            ) {
              resolve(response.headers.etag);
            } else
              reject(
                Object.assign(new Error('Multipart part upload was not accepted.'), {
                  code: 'NETWORK',
                  retryable: true,
                })
              );
          });
        }
      );
      request.once('error', () =>
        reject(
          Object.assign(new Error('Multipart part transfer was interrupted.'), {
            code: 'NETWORK',
            retryable: true,
          })
        )
      );
      body.once('error', () => request.destroy(new Error('Multipart source could not be read.')));
      body.pipe(request);
    });
  } finally {
    body.destroy();
  }
}

export async function uploadWorkspaceMultipart(input: {
  accountId: string;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  resumeStatePath: string;
  session: WorkspaceMultipartSession;
  control: WorkspaceMultipartControl;
  assertAccount: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  objectPath(input.session);
  safeOrigin(input.session.providerOrigin);
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > 5 * 1024 ** 3 ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !UUID.test(input.accountId) ||
    !input.resumeStatePath
  ) {
    throw invalid('Multipart source metadata is invalid.');
  }
  const path = `${input.resumeStatePath}.${input.session.reservationId}.${input.session.generation}.multipart.json`;
  return withUpload(path, async () => {
    input.signal?.throwIfAborted();
    await input.assertAccount();
    const file = await open(input.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await file.stat();
      if (
        !stats.isFile() ||
        stats.size !== input.sizeBytes ||
        (await hashSource(file, input.sizeBytes)) !== input.sha256
      ) {
        throw invalid('Multipart source bytes changed before transfer.');
      }
      const expected: LocalState = {
        schema: 'workspace-sync-multipart-native.v1',
        accountId: input.accountId,
        session: input.session,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        parts: [],
        completed: false,
      };
      const state = await readState(path, expected);
      await input.assertAccount();
      const observed = await input.control.inspect(input.session, input.signal);
      if (!observed || typeof observed.completed !== 'boolean' || !Array.isArray(observed.parts)) {
        throw invalid('Multipart provider state is invalid.');
      }
      if (state.completed && !observed.completed)
        throw invalid('Completed multipart upload changed remotely.');
      const remote = new Map<number, WorkspaceMultipartUploadedPart>();
      for (const part of observed.parts) {
        validatePart(part, input.sizeBytes);
        if (remote.has(part.partNumber)) throw invalid('Multipart provider parts are duplicated.');
        remote.set(part.partNumber, part);
      }
      for (const part of state.parts) {
        const current = remote.get(part.partNumber);
        if (current && current.etag !== part.etag)
          throw invalid('An acknowledged multipart part changed remotely.');
      }
      await saveState(path, state);
      if (!observed.completed) {
        const missing = Array.from(
          { length: Math.ceil(input.sizeBytes / PART_BYTES) },
          (_, index) => index + 1
        ).filter(
          (number) => !state.parts.some((part) => part.partNumber === number && remote.has(number))
        );
        const abort = new AbortController();
        const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
        let cursor = 0;
        let failure: unknown;
        const worker = async () => {
          while (cursor < missing.length) {
            const number = missing[cursor++];
            signal.throwIfAborted();
            await input.assertAccount();
            const capability = await input.control.signPart(input.session, number, signal);
            if (!capability || capability.partNumber !== number)
              throw invalid('Multipart capability names a different part.');
            await input.assertAccount();
            const etag = await sendPart(
              file,
              capability,
              input.session,
              input.sizeBytes,
              AbortSignal.any([signal, AbortSignal.timeout(60_000)])
            );
            validatePart(
              { partNumber: number, sizeBytes: capability.sizeBytes, etag },
              input.sizeBytes
            );
            await withUpload(`${path}:state`, async () => {
              state.parts = state.parts.filter((part) => part.partNumber !== number);
              state.parts.push({ partNumber: number, sizeBytes: capability.sizeBytes, etag });
              await saveState(path, state);
            });
          }
        };
        const settled = await Promise.allSettled(
          Array.from({ length: Math.min(2, missing.length) }, () =>
            worker().catch((error: unknown) => {
              failure ??= error;
              abort.abort();
              throw error;
            })
          )
        );
        if (failure) throw failure;
        if (settled.some((result) => result.status === 'rejected'))
          throw invalid('Multipart transfer did not finish.');
        if (
          (await file.stat()).size !== input.sizeBytes ||
          (await hashSource(file, input.sizeBytes)) !== input.sha256
        )
          throw invalid('Multipart source changed during transfer.');
        await input.assertAccount();
        await input.control.complete(input.session, input.signal);
      }
      state.completed = true;
      await saveState(path, state);
    } finally {
      await file.close();
    }
  });
}
