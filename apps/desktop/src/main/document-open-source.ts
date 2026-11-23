import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { DocumentReadError, documentReadError } from '../shared/document-read-failure';
import { assertSafePath } from './ipc/path-allowlist';

export interface DocumentOpenSource {
  readonly db: Database.Database;
  readonly path: string;
  readonly workspaceRoot: string;
  observe(path: string): Promise<void>;
  observeRevision(key: string, read: () => string | Promise<string>): Promise<void>;
  localPath(path: string): Promise<string>;
  readText(path: string, limit?: number): Promise<string>;
  readBytes(path: string, limit?: number): Promise<Buffer>;
}

type SourceSnapshot = { canonical: string; stat: BigIntStats | undefined };

function fingerprint(stat: BigIntStats | undefined) {
  return stat
    ? `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    : 'missing';
}

export async function documentOpenPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new DocumentReadError('permission');
  try {
    return await assertSafePath(path, { requireAbsolute: true });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Path access denied:'))
      throw new DocumentReadError('permission', false, { cause: error });
    throw error;
  }
}

export function createDocumentOpenSource(
  db: Database.Database,
  workspaceRoot: string,
  initialPath: string,
  canonicalRoot?: string
) {
  const files = new Map<string, Promise<SourceSnapshot>>();
  const observablePaths = new Set<string>();
  const authorities = new Map<string, { revision: string; read(): string | Promise<string> }>();

  async function snapshot(path: string): Promise<SourceSnapshot> {
    if (canonicalRoot && !isPathInsideBoundary(resolve(path), resolve(workspaceRoot)))
      throw new DocumentReadError('permission');
    const canonical = await documentOpenPath(path);
    if (canonicalRoot && !isPathInsideBoundary(canonical, canonicalRoot))
      throw new DocumentReadError('permission');
    observablePaths.add(resolve(path));
    try {
      return { canonical, stat: await lstat(canonical, { bigint: true }) };
    } catch (error) {
      if (documentReadError(error).code !== 'missing') throw error;
      return { canonical, stat: undefined };
    }
  }

  function observeFile(path: string) {
    const key = resolve(path);
    let observed = files.get(key);
    if (!observed) {
      observed = snapshot(path);
      files.set(key, observed);
    }
    return observed;
  }

  async function regularFile(path: string) {
    const observed = await observeFile(path);
    if (!observed.stat)
      throw new DocumentReadError(
        resolve(path) === resolve(initialPath) ? 'missing' : 'missing-asset'
      );
    if (!observed.stat.isFile()) throw new DocumentReadError('unsupported-format');
    return { canonical: observed.canonical, stat: observed.stat };
  }

  async function readBytes(path: string, limit = 64 * 1024 * 1024): Promise<Buffer> {
    const { canonical, stat } = await regularFile(path);
    if (stat.size > limit) throw new DocumentReadError('too-large');
    const handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat))
        throw new DocumentReadError('changed');
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new DocumentReadError('changed');
        offset += bytesRead;
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async function checkReadable(path: string): Promise<void> {
    const { canonical, stat } = await regularFile(path);
    const handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat))
        throw new DocumentReadError('changed');
    } finally {
      await handle.close();
    }
  }

  function forPath(path: string): DocumentOpenSource {
    return {
      path,
      db,
      workspaceRoot,
      observe: async (target) => {
        await observeFile(target);
      },
      observeRevision: async (key, read) => {
        if (!authorities.has(key)) authorities.set(key, { revision: await read(), read });
      },
      localPath: async (target) => (await regularFile(target)).canonical,
      readBytes,
      readText: async (target, limit) => {
        const bytes = await readBytes(target, limit);
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (error) {
          throw new DocumentReadError('malformed', false, { cause: error });
        }
      },
    };
  }

  async function verifyCurrent(): Promise<string> {
    const hash = createHash('sha256');
    for (const [path, captured] of files) {
      const before = await captured;
      const after = await snapshot(path);
      const stamp = fingerprint(before.stat);
      if (before.canonical !== after.canonical || stamp !== fingerprint(after.stat))
        throw new DocumentReadError('changed');
      hash.update(JSON.stringify([path, before.canonical, stamp]));
    }
    for (const [key, { revision, read }] of authorities) {
      if ((await read()) !== revision) throw new DocumentReadError('changed');
      hash.update(JSON.stringify([key, revision]));
    }
    return hash.digest('hex');
  }

  return { forPath, observeFile, verifyCurrent, checkReadable, paths: () => [...observablePaths] };
}
