import { platform } from '../../platform';
import { readCanonicalNotebookPackage } from '../notebook-package-migration';

export async function readNotebookSourceSnapshot(metadataPath: string, metadataRaw: string) {
  const fs = platform().fs;
  const packageRoot = metadataPath.slice(0, -'/.forge/notebook.json'.length);
  const reads = new Map<string, { content: string; mtime: number; size: number }>();
  const missing = new Set<string>();
  const stamp = async (path: string) => {
    const stat = await fs.stat(path);
    const mtime = stat.mtime ?? 0;
    if (!Number.isFinite(mtime)) throw new Error('Notebook source timestamp is invalid.');
    return { mtime, size: stat.size };
  };
  const changed = (path: string): never => {
    throw new Error(`Notebook source changed during reconciliation: ${path}`);
  };
  const readTextFile = async (path: string) => {
    const before = await stamp(path);
    const content = await fs.readTextFile(path);
    const after = await stamp(path);
    if (before.mtime !== after.mtime || before.size !== after.size) changed(path);
    reads.set(path, { content, ...after });
    return content;
  };
  if ((await readTextFile(metadataPath)) !== metadataRaw) changed(metadataPath);
  const result = await readCanonicalNotebookPackage(
    {
      readTextFile,
      exists: async (path) => {
        const present = await fs.exists(path);
        if (!present) missing.add(path);
        return present;
      },
    },
    packageRoot,
    metadataRaw
  );
  const sources = [...reads];
  for (let offset = 0; offset < sources.length; offset += 16) {
    await Promise.all(
      sources.slice(offset, offset + 16).map(async ([path, snapshot]) => {
        const content = await fs.readTextFile(path);
        const current = await stamp(path);
        if (
          content !== snapshot.content ||
          current.mtime !== snapshot.mtime ||
          current.size !== snapshot.size
        )
          changed(path);
      })
    );
  }
  for (const path of missing) if (await fs.exists(path)) changed(path);
  const authority = reads.get(`${packageRoot}/${result.metadata.authority.path}`);
  if (!authority) throw new Error('Notebook Markdown authority was not read.');
  return { ...result, fileMtimeMs: authority.mtime };
}
