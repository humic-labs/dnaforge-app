import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const GENERATED_TREE_DIGEST_ALGORITHM =
  'sha256-length-framed-relative-path-and-content-v1' as const;

export interface FramedFile {
  relativePath: string;
  content: Buffer;
}

function uint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function uint64(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

export function hashFramedFiles(files: readonly FramedFile[]): string {
  const ordered = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
  const seen = new Set<string>();
  const hash = createHash('sha256');
  hash.update('dnaforge.codex-generated-tree.v1\0');

  for (const file of ordered) {
    const relativePath = file.relativePath.split(path.sep).join('/');
    if (
      relativePath.length === 0 ||
      relativePath.startsWith('/') ||
      relativePath.split('/').includes('..') ||
      seen.has(relativePath)
    ) {
      throw new Error(`Invalid generated-tree relative path: ${relativePath}`);
    }
    seen.add(relativePath);
    const pathBytes = Buffer.from(relativePath, 'utf8');
    hash.update(uint32(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64(file.content.length));
    hash.update(file.content);
  }

  return hash.digest('hex');
}

function collectFiles(root: string, dir = root): FramedFile[] {
  const files: FramedFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push({
        relativePath: path.relative(root, absolute).split(path.sep).join('/'),
        content: readFileSync(absolute),
      });
    } else {
      throw new Error(`Generated tree contains a non-file entry: ${absolute}`);
    }
  }
  return files;
}

export function digestGeneratedTree(root: string): string {
  return hashFramedFiles(collectFiles(root));
}

export function extractGeneratedMethodUnion(source: string): string[] {
  const methods = [...source.matchAll(/"method"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(methods)].sort((a, b) => a.localeCompare(b, 'en'));
}
