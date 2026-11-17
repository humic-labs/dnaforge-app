import { isRecoveredComputeResultDirectory } from '../../shared/compute-result-path';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import {
  migrateMolecularFile,
  collectMolecularMigrationGitContent,
  molecularMigrationPathProtected,
  pendingMolecularMigrationSources,
  type MolecularMigrationKind,
  type MolecularMigrationOptions,
  type MolecularMigrationResult,
} from './molecular-migration-journal';

export type CoordinatePackageResult =
  | { converted: true; productPath: string }
  | { converted: false; skippedReason?: string };

export async function materializeCoordinatePackage(
  coordinatePath: string,
  options: MolecularMigrationOptions & {
    removeSource: (path: string) => Promise<unknown>;
    now?: () => number;
  }
): Promise<CoordinatePackageResult> {
  try {
    const result = await materializeCoordinatePackageWithJournal(coordinatePath, options);
    return result ? { converted: true, productPath: result.productPath } : { converted: false };
  } catch (error) {
    return {
      converted: false,
      skippedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function materializeCoordinatePackageWithJournal(
  coordinatePath: string,
  options: MolecularMigrationOptions & {
    removeSource: (path: string) => Promise<unknown>;
    now?: () => number;
  }
): Promise<MolecularMigrationResult | null> {
  const fileName = basename(coordinatePath);
  const format = packagedCoordinateFormat(fileName);
  if (!format) return null;
  for (let directory = dirname(resolve(coordinatePath)); ; directory = dirname(directory)) {
    if (await packageDirectory(directory))
      throw new Error(`MOLECULAR_MIGRATION_PACKAGE_MEMBER: ${coordinatePath}`);
    if (dirname(directory) === directory) break;
  }
  const stem = coordinateFileStem(fileName);
  return migrateMolecularFile(
    coordinatePath,
    'coordinate',
    async (bytes) => ({
      content: serializeMolecularDocument(
        await buildDefaultMolecularDocument({
          name: stem,
          format,
          text: format === 'bcif' ? binaryCoordinateText(bytes) : bytes.toString('utf8'),
          createdAt: (options.now ?? Date.now)(),
          documentId: randomUUID(),
          referenceId: randomUUID(),
        })
      ),
      productNames: molecularViewNames(stem),
    }),
    options
  );
}

const SKIPPED_ROOT_DIRECTORIES = new Set(['Structures', 'compute', 'node_modules']);
const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_DEPTH = 40;
const PACKAGE_MARKERS = [
  'plasmid.json',
  'sequence.json',
  'notebook.json',
  'protocol.json',
  'protocol-run.json',
];

function molecularViewNames(stem: string): string[] {
  return Array.from(
    { length: 1000 },
    (_, n) => `${n === 0 ? stem : `${stem} ${n + 1}`}${MOLECULAR_DOCUMENT_SUFFIX}`
  );
}

async function packageDirectory(path: string): Promise<boolean> {
  for (const name of PACKAGE_MARKERS) {
    try {
      await lstat(join(path, '.forge', name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function molecularMigrationCandidates(
  repoPath: string,
  kind: MolecularMigrationKind,
  options: MolecularMigrationOptions,
  result: MolecularTreeMigrationResult
): Promise<string[]> {
  const candidates = new Set<string>();
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    const protectedDirectory = options.protectedPaths?.some((path) => {
      const member = relative(resolve(path), resolve(directory));
      return (
        member === '' || (!isAbsolute(member) && member !== '..' && !member.startsWith(`..${sep}`))
      );
    });
    if (depth > MAX_TREE_DEPTH || protectedDirectory || (await packageDirectory(directory))) return;
    try {
      for (const source of await pendingMolecularMigrationSources(directory, kind))
        candidates.add(source);
      const completed = await collectMolecularMigrationGitContent(directory, kind, options);
      recordMutation(repoPath, result, completed.expectedContentSha256);
      result.skipped.push(...completed.skipped);
    } catch (error) {
      result.skipped.push({
        path: directory,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > MAX_TREE_ENTRIES) return;
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'test-fixtures' ||
        entry.name === '__pycache__'
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          depth === 0 &&
          (SKIPPED_ROOT_DIRECTORIES.has(entry.name) ||
            isRecoveredComputeResultDirectory(entry.name))
        )
          continue;
        await walk(path, depth + 1);
      } else if (
        entry.isFile() &&
        !molecularMigrationPathProtected(path, options.protectedPaths) &&
        (kind === 'coordinate'
          ? packagedCoordinateFormat(entry.name)
          : extensionFreeMolecularViewPath(entry.name))
      ) {
        candidates.add(path);
      }
    }
  };
  await walk(repoPath, 0);
  return [...candidates];
}

interface MolecularTreeMigrationResult {
  skipped: Array<{ path: string; reason: string }>;
  mutatedGitFiles: string[];
  expectedContentSha256: Record<string, string | null>;
}

function recordMutation(
  repoPath: string,
  result: MolecularTreeMigrationResult,
  expectedContentSha256: Record<string, string | null>
): void {
  for (const [path, sha256] of Object.entries(expectedContentSha256)) {
    const member = relative(repoPath, path).split(sep).join('/');
    result.expectedContentSha256[member] = sha256;
  }
  result.mutatedGitFiles = Object.keys(result.expectedContentSha256);
}

export async function convertTreeToMolecularPackages(
  repoPath: string,
  options: MolecularMigrationOptions & { removeSource: (path: string) => Promise<unknown> }
): Promise<MolecularTreeMigrationResult & { converted: number }> {
  const result = {
    converted: 0,
    skipped: [],
    mutatedGitFiles: [],
    expectedContentSha256: {},
  } as MolecularTreeMigrationResult & { converted: number };
  const candidates = await molecularMigrationCandidates(repoPath, 'coordinate', options, result);
  for (const path of candidates) {
    try {
      const migration = await materializeCoordinatePackageWithJournal(path, options);
      if (migration) {
        result.converted += 1;
        recordMutation(repoPath, result, migration.expectedContentSha256);
      }
    } catch (error) {
      result.skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

const EXTENSION_NAMED_VIEW = /\.(pdb|ent|cif|mmcif|bcif)(\.dnaforge-molecular\.json)$/i;

export function extensionFreeMolecularViewPath(path: string): string | null {
  return EXTENSION_NAMED_VIEW.test(path) ? path.replace(EXTENSION_NAMED_VIEW, '$2') : null;
}

export async function renameExtensionNamedMolecularViews(
  repoPath: string,
  options: MolecularMigrationOptions = {}
): Promise<MolecularTreeMigrationResult & { renamed: number }> {
  const result = {
    renamed: 0,
    skipped: [],
    mutatedGitFiles: [],
    expectedContentSha256: {},
  } as MolecularTreeMigrationResult & { renamed: number };
  const candidates = await molecularMigrationCandidates(
    repoPath,
    'extension-name',
    options,
    result
  );
  for (const path of candidates) {
    try {
      const migration = await migrateMolecularFile(
        path,
        'extension-name',
        async (bytes) => {
          const document = parseMolecularDocument(bytes.toString('utf8'));
          if (options.protectedEntityIds?.has(document.id))
            throw new Error('MOLECULAR_MIGRATION_IDENTITY_OWNED');
          const name = coordinateFileStem(document.name).trim() || document.name;
          const stem = basename(extensionFreeMolecularViewPath(path)!).slice(
            0,
            -MOLECULAR_DOCUMENT_SUFFIX.length
          );
          return {
            content: serializeMolecularDocument({ ...document, name }),
            productNames: molecularViewNames(stem),
          };
        },
        { ...options, removeSource: unlink }
      );
      result.renamed += 1;
      recordMutation(repoPath, result, migration.expectedContentSha256);
    } catch (error) {
      result.skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
