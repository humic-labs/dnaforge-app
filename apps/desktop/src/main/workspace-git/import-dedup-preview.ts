import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { collectExistingFileHashes, hashContentSha256 } from './import-hashes';
import { decideImportDedup, type DedupPreviewItem } from '../../shared/import-dedup';

export type { DedupPreviewItem };

export async function previewImportDedup(
  sourcePaths: string[],
  targetRoot: string
): Promise<DedupPreviewItem[]> {
  const existing = await collectExistingFileHashes(targetRoot);
  const out: DedupPreviewItem[] = [];
  for (const sourcePath of sourcePaths) {
    const contentHash = hashContentSha256(await readFile(sourcePath));
    const decision = decideImportDedup({ name: basename(sourcePath), contentHash }, existing);
    out.push({ sourcePath, decision });
  }
  return out;
}
