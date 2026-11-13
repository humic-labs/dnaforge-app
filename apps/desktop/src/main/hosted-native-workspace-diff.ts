import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const MAX_ENTRIES = 5_000;
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

export interface HostedWorkspaceSnapshotEntry {
  readonly kind: 'file' | 'directory';
  readonly byte_count?: number;
  readonly sha256?: string;
  readonly modified_ms?: number;
}

export type HostedWorkspaceSnapshot = ReadonlyMap<string, HostedWorkspaceSnapshotEntry>;

export interface HostedWorkspaceDiffEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly operation: 'create' | 'update' | 'delete';
  readonly before?: { readonly sha256?: string; readonly byte_count?: number };
  readonly after?: { readonly sha256?: string; readonly byte_count?: number };
}

export async function snapshotHostedWorkspace(root: string): Promise<HostedWorkspaceSnapshot> {
  const result = new Map<string, HostedWorkspaceSnapshotEntry>();
  const visit = async (directory: string): Promise<void> => {
    if (result.size >= MAX_ENTRIES) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (result.size >= MAX_ENTRIES || entry.isSymbolicLink()) break;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).replaceAll('\\', '/');
      if (!path || path.startsWith('../')) continue;
      const info = await lstat(absolutePath).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        result.set(path, { kind: 'directory', modified_ms: info.mtimeMs });
        await visit(absolutePath);
      } else if (info.isFile()) {
        const digest =
          info.size <= MAX_HASHED_FILE_BYTES
            ? createHash('sha256')
                .update(await readFile(absolutePath))
                .digest('hex')
            : undefined;
        result.set(path, {
          kind: 'file',
          byte_count: info.size,
          ...(digest ? { sha256: digest } : {}),
          modified_ms: info.mtimeMs,
        });
      }
    }
  };
  await visit(root);
  return result;
}

function publicState(entry: HostedWorkspaceSnapshotEntry | undefined) {
  if (!entry) return undefined;
  return {
    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
    ...(entry.byte_count !== undefined ? { byte_count: entry.byte_count } : {}),
  };
}

export function diffHostedWorkspace(
  before: HostedWorkspaceSnapshot,
  after: HostedWorkspaceSnapshot
): HostedWorkspaceDiffEntry[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((path) => {
    const left = before.get(path);
    const right = after.get(path);
    if (
      left &&
      right &&
      left.kind === right.kind &&
      left.sha256 === right.sha256 &&
      left.byte_count === right.byte_count &&
      left.modified_ms === right.modified_ms
    )
      return [];
    return [
      {
        path,
        kind: right?.kind ?? left?.kind ?? 'file',
        operation: !left ? 'create' : !right ? 'delete' : 'update',
        ...(left ? { before: publicState(left) } : {}),
        ...(right ? { after: publicState(right) } : {}),
      } satisfies HostedWorkspaceDiffEntry,
    ];
  });
}
