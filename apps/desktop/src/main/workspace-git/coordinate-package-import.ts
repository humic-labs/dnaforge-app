import { isRecoveredComputeResultDirectory } from '../../shared/compute-result-path';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  buildDefaultMolecularDocument,
  coordinateFileStem,
  packagedCoordinateFormat,
} from '../../shared/default-molecular-view';
import { binaryCoordinateText } from '../../shared/binary-coordinates';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  parseMolecularDocument,
  serializeMolecularDocument,
} from '../../shared/molecular-document';

export type CoordinatePackageResult =
  | { converted: true; productPath: string }
  | { converted: false; skippedReason?: string };

export async function materializeCoordinatePackage(
  coordinatePath: string,
  options: { removeSource: (path: string) => Promise<unknown>; now?: () => number }
): Promise<CoordinatePackageResult> {
  const fileName = basename(coordinatePath);
  const format = packagedCoordinateFormat(fileName);
  if (!format) return { converted: false };
  const stem = coordinateFileStem(fileName);
  let content: string;
  try {
    content = serializeMolecularDocument(
      await buildDefaultMolecularDocument({
        name: stem,
        format,
        text:
          format === 'bcif'
            ? binaryCoordinateText(await readFile(coordinatePath))
            : await readFile(coordinatePath, 'utf8'),
        createdAt: (options.now ?? Date.now)(),
        documentId: randomUUID(),
        referenceId: randomUUID(),
      })
    );
  } catch (error) {
    return {
      converted: false,
      skippedReason: error instanceof Error ? error.message : String(error),
    };
  }
  const directory = dirname(coordinatePath);
  for (let n = 1; n <= 1000; n += 1) {
    const productPath = join(
      directory,
      `${n === 1 ? stem : `${stem} ${n}`}${MOLECULAR_DOCUMENT_SUFFIX}`
    );
    try {
      await writeFile(productPath, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      await options.removeSource(coordinatePath);
    } catch (error) {
      await unlink(productPath).catch(() => {});
      return {
        converted: false,
        skippedReason: `The coordinate file could not be removed after packaging: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return { converted: true, productPath };
  }
  throw new Error(`No free molecular view name beside ${coordinatePath}.`);
}

const SKIPPED_ROOT_DIRECTORIES = new Set(['Structures', 'compute', 'node_modules']);
const MAX_TREE_ENTRIES = 50_000;

export async function convertTreeToMolecularPackages(
  repoPath: string,
  options: { removeSource: (path: string) => Promise<unknown> }
): Promise<{ converted: number; skipped: Array<{ path: string; reason: string }> }> {
  const candidates: string[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > MAX_TREE_ENTRIES) return;
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          depth === 0 &&
          (SKIPPED_ROOT_DIRECTORIES.has(entry.name) ||
            isRecoveredComputeResultDirectory(entry.name))
        )
          continue;
        await walk(path, depth + 1);
      } else if (entry.isFile() && packagedCoordinateFormat(entry.name)) {
        candidates.push(path);
      }
    }
  };
  await walk(repoPath, 0);
  let converted = 0;
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const path of candidates) {
    try {
      const result = await materializeCoordinatePackage(path, options);
      if (result.converted) converted += 1;
      else if (result.skippedReason) skipped.push({ path, reason: result.skippedReason });
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { converted, skipped };
}

const EXTENSION_NAMED_VIEW = /\.(pdb|ent|cif|mmcif|bcif)(\.dnaforge-molecular\.json)$/i;

export function extensionFreeMolecularViewPath(path: string): string | null {
  return EXTENSION_NAMED_VIEW.test(path) ? path.replace(EXTENSION_NAMED_VIEW, '$2') : null;
}

export async function renameExtensionNamedMolecularViews(
  repoPath: string
): Promise<{ renamed: number; skipped: Array<{ path: string; reason: string }> }> {
  const candidates: string[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > MAX_TREE_ENTRIES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          depth === 0 &&
          (entry.name === 'compute' || isRecoveredComputeResultDirectory(entry.name))
        )
          continue;
        await walk(path, depth + 1);
      } else if (entry.isFile() && extensionFreeMolecularViewPath(entry.name))
        candidates.push(path);
    }
  };
  await walk(repoPath, 0);
  let renamed = 0;
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const path of candidates) {
    try {
      const document = parseMolecularDocument(await readFile(path, 'utf8'));
      const name = coordinateFileStem(document.name).trim() || document.name;
      const content = serializeMolecularDocument({ ...document, name });
      const base = extensionFreeMolecularViewPath(path)!.slice(
        0,
        -MOLECULAR_DOCUMENT_SUFFIX.length
      );
      let written: string | null = null;
      for (let n = 1; n <= 1000 && !written; n += 1) {
        const candidate = `${n === 1 ? base : `${base} ${n}`}${MOLECULAR_DOCUMENT_SUFFIX}`;
        try {
          await writeFile(candidate, content, { flag: 'wx' });
          written = candidate;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        }
      }
      if (!written) throw new Error('No free molecular view name.');
      await unlink(path);
      renamed += 1;
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { renamed, skipped };
}
