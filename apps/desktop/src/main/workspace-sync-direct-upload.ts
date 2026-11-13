import { createHash } from 'node:crypto';
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  Upload,
  type HttpRequest,
  type HttpResponse,
  type PreviousUpload,
  type UrlStorage,
} from 'tus-js-client';
import { decodeBundleFileContent, type WorkspaceSyncFile } from '@waypoint/share-bundle';
import { syncDirectory } from './fs-durability';
import {
  verifyWorkspaceSyncBlob,
  workspaceSyncBlobCacheRoot,
  workspaceSyncBlobPath,
} from './workspace-sync-blob-cache';

export interface WorkspaceSyncDirectUpload {
  protocol: 'tus';
  endpoint: string;
  token: string;
  bucket: string;
  path: string;
  expiresAt: string;
  upsert: false;
}
const CHUNK_BYTES = 6 * 1024 * 1024;

export function parseWorkspaceSyncDirectUpload(value: unknown): WorkspaceSyncDirectUpload {
  if (!value || typeof value !== 'object') throw new Error('Invalid direct upload reservation.');
  const v = value as Record<string, unknown>;
  const endpoint = typeof v.endpoint === 'string' ? new URL(v.endpoint) : null;
  const local =
    endpoint &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
    endpoint.protocol === 'http:';
  if (
    v.protocol !== 'tus' ||
    !endpoint ||
    (!local &&
      (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.storage.supabase.co'))) ||
    endpoint.pathname !== '/storage/v1/upload/resumable/sign' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    typeof v.token !== 'string' ||
    !v.token ||
    v.bucket !== 'workspace-snapshots' ||
    typeof v.path !== 'string' ||
    !v.path ||
    v.path.length > 1024 ||
    v.path.startsWith('/') ||
    v.path.includes('\\') ||
    Array.from(v.path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    v.path.split('/').some((p) => !p || p === '.' || p === '..') ||
    typeof v.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    Date.parse(v.expiresAt) <= Date.now() ||
    v.upsert !== false
  ) {
    throw new Error('Invalid direct upload reservation.');
  }
  return {
    protocol: 'tus',
    endpoint: endpoint.href,
    token: v.token,
    bucket: 'workspace-snapshots',
    path: v.path,
    expiresAt: v.expiresAt,
    upsert: false,
  };
}

function validUploadUrl(endpoint: string, candidate: string): boolean {
  const base = new URL(endpoint);
  const url = new URL(candidate);
  return (
    url.origin === base.origin &&
    url.pathname.startsWith(`${base.pathname}/`) &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.search
  );
}

function urlStorage(path: string, endpoint: string): UrlStorage {
  const read = async (): Promise<PreviousUpload[]> => {
    try {
      const bytes = await readFile(path, 'utf8');
      if (bytes.length > 16 * 1024) throw new Error('Invalid upload journal.');
      const saved = JSON.parse(bytes) as PreviousUpload;
      if (!saved.uploadUrl || !validUploadUrl(endpoint, saved.uploadUrl))
        throw new Error('Invalid upload journal URL.');
      return [saved];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    findAllUploads: read,
    findUploadsByFingerprint: read,
    removeUpload: async () => {
      await rm(path, { force: true });
      await syncDirectory(dirname(path));
    },
    addUpload: async (fingerprint, upload) => {
      if (!upload.uploadUrl || !validUploadUrl(endpoint, upload.uploadUrl))
        throw new Error('Storage returned an unsafe resumable URL.');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      const handle = await open(temp, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ ...upload, urlStorageKey: fingerprint }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
      await syncDirectory(dirname(path));
      return fingerprint;
    },
  };
}

export async function uploadWorkspaceSyncFileDirect(
  file: WorkspaceSyncFile,
  capability: WorkspaceSyncDirectUpload,
  fingerprint: string,
  options: {
    signal?: AbortSignal;
    cacheRoot?: string;
    assertAccount?: () => Promise<void>;
    fetch?: typeof fetch;
  } = {}
): Promise<void> {
  const root = options.cacheRoot ?? (await workspaceSyncBlobCacheRoot());
  options.signal?.throwIfAborted();
  const inline = file.encoding === 'blob' ? undefined : Buffer.from(decodeBundleFileContent(file));
  if (file.encoding === 'blob') await verifyWorkspaceSyncBlob(file, options);
  const source =
    file.encoding === 'blob'
      ? await open(await workspaceSyncBlobPath(file.sha256, root), 'r')
      : undefined;
  const before = await source?.stat();
  const fetchImpl = options.fetch ?? fetch;
  try {
    const journal = join(
      root,
      'uploads',
      `${createHash('sha256').update(fingerprint).digest('hex')}.json`
    );
    await new Promise<void>((resolve, reject) => {
      let accountError: unknown;
      const upload = new Upload(inline ?? Buffer.alloc(0), {
        endpoint: capability.endpoint,
        retryDelays: [0, 1000, 3000, 5000],
        chunkSize: CHUNK_BYTES,
        uploadSize: file.sizeBytes,
        uploadDataDuringCreation: false,
        headers: { 'x-signature': capability.token, 'x-upsert': 'false' },
        metadata: {
          bucketName: capability.bucket,
          objectName: capability.path,
          contentType: file.contentType,
          cacheControl: '3600',
        },
        fingerprint: async () => fingerprint,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        urlStorage: urlStorage(journal, capability.endpoint),
        fileReader: {
          openFile: async () => ({
            size: file.sizeBytes,
            close: () => undefined,
            slice: async (start, end) => {
              options.signal?.throwIfAborted();
              if (
                !Number.isSafeInteger(start) ||
                !Number.isSafeInteger(end) ||
                start < 0 ||
                end < start ||
                end - start > CHUNK_BYTES
              )
                throw new Error('Invalid TUS file range.');
              const stop = Math.min(end, file.sizeBytes);
              const bytes = inline
                ? inline.subarray(start, stop)
                : Buffer.allocUnsafe(stop - start);
              if (source) {
                let read = 0;
                while (read < bytes.length) {
                  const result = await source.read(bytes, read, bytes.length - read, start + read);
                  if (!result.bytesRead) throw new Error('Durable upload bytes changed.');
                  read += result.bytesRead;
                }
              }
              return {
                value: Object.assign(bytes, { size: bytes.length }),
                done: stop === file.sizeBytes,
              };
            },
          }),
        },
        httpStack: {
          getName: () => 'dnaforge-bounded-fetch',
          createRequest: (method, url): HttpRequest => {
            if (url !== capability.endpoint && !validUploadUrl(capability.endpoint, url))
              throw new Error('Unsafe TUS request URL.');
            const headers = new Headers();
            const controller = new AbortController();
            return {
              getMethod: () => method,
              getURL: () => url,
              setHeader: (key, value) => {
                headers.set(key, value);
              },
              getHeader: (key) => headers.get(key) ?? undefined,
              setProgressHandler: () => undefined,
              getUnderlyingObject: () => controller,
              abort: async () => {
                controller.abort();
              },
              send: async (body) => {
                try {
                  await options.assertAccount?.();
                } catch (error) {
                  accountError = error;
                  throw error;
                }
                options.signal?.throwIfAborted();
                const signal = AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(120_000),
                  ...(options.signal ? [options.signal] : []),
                ]);
                const response = await fetchImpl(url, {
                  method,
                  headers,
                  body,
                  signal,
                  redirect: 'error',
                });
                await response.body?.cancel();
                return {
                  getStatus: () => response.status,
                  getHeader: (key) => response.headers.get(key) ?? undefined,
                  getBody: () => '',
                  getUnderlyingObject: () => response,
                } satisfies HttpResponse;
              },
            };
          },
        },
        onShouldRetry: (error) =>
          !accountError &&
          !options.signal?.aborted &&
          (!error.originalResponse ||
            error.originalResponse.getStatus() >= 500 ||
            error.originalResponse.getStatus() === 409),
        onError: (error) => {
          cleanup();
          reject(accountError ?? error);
        },
        onSuccess: () => {
          cleanup();
          resolve();
        },
      });
      const abort = () => {
        void upload.abort().then(() => {
          cleanup();
          reject(options.signal?.reason ?? new Error('Upload aborted.'));
        }, reject);
      };
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      options.signal?.addEventListener('abort', abort, { once: true });
      void upload.findPreviousUploads().then(
        (previous) => {
          if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
          if (options.signal?.aborted) {
            abort();
            return;
          }
          upload.start();
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });
    if (source && before) {
      const after = await source.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error('Durable upload bytes changed.');
    }
  } finally {
    await source?.close();
  }
}
