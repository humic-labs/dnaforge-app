import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { detectDocumentPackage } from '../../shared/document-package';
import { FORGE_PACKAGE_MARKER_DIR } from '../../shared/forge-package-path';

export interface MigrationPathOptions {
  protectedPaths?: readonly string[];
  protectedEntityIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  withCleanPaths?: <T>(paths: readonly string[], operation: () => Promise<T>) => Promise<T>;
}

export function migrationPathsIntersect(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

export async function hasDocumentPackageMarker(directory: string): Promise<boolean> {
  const markers = join(directory, FORGE_PACKAGE_MARKER_DIR);
  try {
    if (!(await fs.lstat(markers)).isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const entries = await fs.readdir(markers);
  if (entries.some((name) => name.toLowerCase() === 'sequence.json')) return true;
  return Boolean(
    await detectDocumentPackage(directory, {
      exists: async () => true,
      readDir: async () => entries.map((name) => ({ name, isFile: true, isDirectory: false })),
    })
  );
}

export async function isOrdinaryMigrationContainer(
  binding: { path: string; file_kind: string; type: string | null },
  member: string
): Promise<boolean> {
  if (binding.type !== 'folder' || binding.file_kind !== 'folder') return false;
  const rel = relative(binding.path, member);
  return Boolean(
    rel &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel) &&
    !(await hasDocumentPackageMarker(resolve(binding.path)))
  );
}

export function assertMigrationPathsAvailable(
  paths: readonly string[],
  options: MigrationPathOptions
): void {
  options.assertCurrent?.();
  for (const path of paths) {
    if (
      options.protectedPaths?.some((protectedPath) => migrationPathsIntersect(path, protectedPath))
    )
      throw new Error(
        `The existing entity at "${path}" owns this location; it was left unchanged.`
      );
  }
}

export async function captureMigrationGitContent(root: string, paths: readonly string[]) {
  const expectedContentSha256: Record<string, string | null> = {};
  for (const path of paths) {
    const relPath = relative(root, path);
    if (!relPath || relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath))
      throw new Error('Migration output is outside its project.');
    const key = relPath.split(sep).join('/');
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error(`Migration output is not a file: "${path}".`);
      const hash = createHash('sha256');
      if (stat.isSymbolicLink()) hash.update(await fs.readlink(path));
      else for await (const chunk of createReadStream(path)) hash.update(chunk);
      const after = await fs.lstat(path);
      if (
        stat.dev !== after.dev ||
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs ||
        stat.ctimeMs !== after.ctimeMs
      )
        throw new Error(`Migration output changed while it was being recorded: "${path}".`);
      expectedContentSha256[key] = hash.digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      expectedContentSha256[key] = null;
    }
  }
  return { mutatedGitFiles: Object.keys(expectedContentSha256).sort(), expectedContentSha256 };
}
