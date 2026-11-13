import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { PreparedSourceFileIdentity } from './prepared-reference-source-receipt';

export const DNA_INDEXER_SCHEMA = 2;

export interface PreparedSourcePaths {
  readonly fasta: string;
  readonly gff?: string;
}

export interface PreparedOutputPaths {
  readonly fasta: string;
  readonly fai: string;
  readonly gzi?: string;
  readonly gff?: string;
  readonly tbi?: string;
}

export function preparedBgzfSequenceFiles(chrom: string): {
  readonly fasta: string;
  readonly fai: string;
  readonly gzi: string;
} {
  return {
    fasta: `${chrom}.fa.gz`,
    fai: `${chrom}.fa.gz.fai`,
    gzi: `${chrom}.fa.gz.gzi`,
  };
}

export function gziPathForPreparedFasta(fastaPath: string): string | null {
  return fastaPath.toLowerCase().endsWith('.gz') ? `${fastaPath}.gzi` : null;
}

export async function isBgzfFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead < 18 || header[0] !== 0x1f || header[1] !== 0x8b || (header[3] & 0x04) === 0) {
      return false;
    }
    const extraLength = header[10] | (header[11] << 8);
    const end = Math.min(bytesRead, 12 + extraLength);
    for (let offset = 12; offset + 4 <= end; ) {
      const length = header[offset + 2] | (header[offset + 3] << 8);
      if (header[offset] === 0x42 && header[offset + 1] === 0x43 && length === 2) return true;
      offset += 4 + length;
    }
    return false;
  } finally {
    await handle.close();
  }
}

export async function readDnaIndexerSchema(path: string): Promise<number | null> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(18);
    const headerRead = await handle.read(header, 0, header.byteLength, 0);
    if (headerRead.bytesRead < 18) return null;
    const blockSize = (header[16] | (header[17] << 8)) + 1;
    const block = Buffer.alloc(blockSize);
    const blockRead = await handle.read(block, 0, block.byteLength, 0);
    if (blockRead.bytesRead !== blockSize) return null;
    const text = gunzipSync(block).toString('utf8');
    const match = /^##dna-indexer-schema\s+(\d+)$/m.exec(text);
    return match ? Number(match[1]) : null;
  } finally {
    await handle.close();
  }
}

export async function readPreparedFaiLength(path: string, expectedChrom: string): Promise<number> {
  const rows = (await readFile(path, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (rows.length !== 1) {
    throw new Error(`${path} must contain exactly one FASTA index row.`);
  }
  const columns = rows[0].split('\t');
  const length = Number(columns[1]);
  if (columns[0] !== expectedChrom || !Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`${path} does not describe ${expectedChrom} with a positive safe length.`);
  }
  return length;
}

export async function verifyOptionalSha256(
  path: string,
  expected: string | undefined,
  label: string
): Promise<void> {
  if (!expected) return;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const actual = hash.digest('hex');
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}.`);
  }
}

export async function fileIdentity(path: string): Promise<PreparedSourceFileIdentity> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0)
    throw new Error(`File is missing or empty: ${path}`);
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

export function assertAtOrBelow(root: string, candidate: string, label: string): void {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new Error(`${label} must be absolute.`);
  }
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`${label} is outside the project root: ${candidate}`);
  }
}
