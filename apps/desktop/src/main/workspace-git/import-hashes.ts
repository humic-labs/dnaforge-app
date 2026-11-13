import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { MANAGED_WORKSPACE_MARKER } from '../../shared/workspace-git-types';
import type { ExistingWorkspaceFile } from '../../shared/import-dedup';

const SKIP = new Set(['.git', 'node_modules', '.DS_Store', MANAGED_WORKSPACE_MARKER]);

export function hashContentSha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function collectExistingFileHashes(rootDir: string): Promise<ExistingWorkspaceFile[]> {
  const out: ExistingWorkspaceFile[] = [];
  await walk(rootDir, rootDir, out);
  return out;
}

async function walk(root: string, dir: string, out: ExistingWorkspaceFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const buf = await readFile(abs);
    out.push({
      relPath: relative(root, abs).split(sep).join('/'),
      name: entry.name,
      contentHash: hashContentSha256(buf),
    });
  }
}
