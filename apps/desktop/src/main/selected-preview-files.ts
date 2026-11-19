import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { externalFormatForPath } from '../shared/external-preview';

const selected = new Set<string>();

export function rememberSelectedPreviewFile(path: string): void {
  const format = typeof path === 'string' && isAbsolute(path) && externalFormatForPath(path);
  if (!format) return;
  try {
    const canonical = realpathSync.native(path);
    if (externalFormatForPath(canonical) !== format || !statSync(canonical).isFile()) return;
    selected.add(canonical);
  } catch {
    return;
  }
}

export async function resolvePreviewSource(
  path: string,
  resolveOrdinaryPath: (path: string) => Promise<string>
): Promise<string> {
  const format = typeof path === 'string' && isAbsolute(path) && externalFormatForPath(path);
  if (!format) throw new Error('Choose a supported preview file.');
  let canonical: string;
  try {
    canonical = await resolveOrdinaryPath(path);
  } catch (error) {
    try {
      canonical = realpathSync.native(path);
    } catch {
      throw error;
    }
    if (!selected.has(canonical)) throw error;
  }
  if (externalFormatForPath(canonical) !== format)
    throw new Error('The preview source resolves to a different file type.');
  return canonical;
}

export async function admitFileImportSource<
  T extends { sourcePath: string; preserveOriginal?: boolean },
>(request: T, resolveOrdinaryPath: (path: string) => Promise<string>): Promise<T> {
  if (request.preserveOriginal) {
    const sourcePath = await resolvePreviewSource(request.sourcePath, resolveOrdinaryPath);
    return { ...request, sourcePath };
  }
  return { ...request, sourcePath: await resolveOrdinaryPath(request.sourcePath) };
}
