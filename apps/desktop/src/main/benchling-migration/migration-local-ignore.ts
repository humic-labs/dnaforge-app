import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BEGIN = '# BEGIN DNAForge Benchling migration (managed)';
const END = '# END DNAForge Benchling migration (managed)';

export const MIGRATION_LOCAL_IGNORE_BLOCK = [
  BEGIN,
  '.dnaforge/migration/migration.sqlite',
  '.dnaforge/migration/migration.sqlite-wal',
  '.dnaforge/migration/migration.sqlite-shm',
  '.dnaforge/migration/external-sources/',
  '.dnaforge/migration/action-journals/',
  '.dnaforge/migration/actions/',
  '.dnaforge/migration/projection-staging/',
  '.dnaforge/migration/tmp/',
  '.dnaforge/migration/rollback/',
  END,
].join('\n');

export async function mergeMigrationLocalIgnore(workspacePath: string): Promise<void> {
  const ignorePath = join(workspacePath, '.gitignore');
  let existing = '';
  try {
    const info = await lstat(ignorePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Workspace .gitignore must be a regular file.');
    }
    existing = await readFile(ignorePath, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing.includes(BEGIN) || existing.includes(END)) {
    if (existing.includes(MIGRATION_LOCAL_IGNORE_BLOCK)) return;
    throw new Error('Workspace contains a modified DNAForge migration ignore block.');
  }
  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const next = `${existing}${separator}${MIGRATION_LOCAL_IGNORE_BLOCK}\n`;
  const temporaryPath = join(workspacePath, `.gitignore.dnaforge-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, next, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, ignorePath);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
