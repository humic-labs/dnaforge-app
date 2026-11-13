import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parseBenchlingRegistryProjectionDocument,
  serializeBenchlingRegistryProjection,
  type BenchlingRegistryProjectionDocument,
} from './registry-projection';

export const BENCHLING_REGISTRY_PROJECTION_DIRECTORY = '.dnaforge/migration/registry-projections';
export const BENCHLING_REGISTRY_PROJECTION_STAGING_DIRECTORY =
  '.dnaforge/migration/projection-staging/registry-projections';
const FILE_PATTERN = /^registry-([a-f0-9]{64})\.json$/;

export async function persistBenchlingRegistryProjectionDocument(input: {
  workspacePath: string;
  document: BenchlingRegistryProjectionDocument;
}): Promise<{ path: string; relativePath: string; sha256: string }> {
  const workspacePath = resolve(input.workspacePath);
  const directory = join(workspacePath, BENCHLING_REGISTRY_PROJECTION_DIRECTORY);
  await assertRegularDirectoryPathOrMissing(workspacePath, BENCHLING_REGISTRY_PROJECTION_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await assertRegularDirectoryPathOrMissing(workspacePath, BENCHLING_REGISTRY_PROJECTION_DIRECTORY);
  const contents = serializeBenchlingRegistryProjection(input.document);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const path = join(directory, `registry-${sha256}.json`);
  if (existsSync(path)) {
    const existing = await readFile(path, 'utf8');
    if (existing !== contents) {
      throw new Error(`Registry projection content-address collision at ${path}.`);
    }
    return {
      path,
      relativePath: `${BENCHLING_REGISTRY_PROJECTION_DIRECTORY}/registry-${sha256}.json`,
      sha256,
    };
  }

  const stagingDirectory = join(workspacePath, BENCHLING_REGISTRY_PROJECTION_STAGING_DIRECTORY);
  await assertRegularDirectoryPathOrMissing(
    workspacePath,
    BENCHLING_REGISTRY_PROJECTION_STAGING_DIRECTORY
  );
  await mkdir(stagingDirectory, { recursive: true });
  await assertRegularDirectoryPathOrMissing(
    workspacePath,
    BENCHLING_REGISTRY_PROJECTION_STAGING_DIRECTORY
  );
  const temporaryPath = join(stagingDirectory, `${sha256}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return {
    path,
    relativePath: `${BENCHLING_REGISTRY_PROJECTION_DIRECTORY}/registry-${sha256}.json`,
    sha256,
  };
}

export async function readBenchlingRegistryProjectionDocuments(
  workspacePathInput: string
): Promise<BenchlingRegistryProjectionDocument[]> {
  const workspacePath = resolve(workspacePathInput);
  const directory = join(workspacePath, BENCHLING_REGISTRY_PROJECTION_DIRECTORY);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  await assertRegularDirectoryPathOrMissing(workspacePath, BENCHLING_REGISTRY_PROJECTION_DIRECTORY);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Benchling registry projection path must be a regular directory.');
  }

  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const documents: BenchlingRegistryProjectionDocument[] = [];
  for (const entry of entries) {
    if (!FILE_PATTERN.test(entry.name)) {
      throw new Error(`Unexpected Benchling registry projection entry ${entry.name}.`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Benchling registry projection ${entry.name} must be a regular file.`);
    }
    const match = FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    const contents = await readFile(join(directory, entry.name), 'utf8');
    const actualHash = createHash('sha256').update(contents).digest('hex');
    if (actualHash !== match[1]) {
      throw new Error(`Benchling registry projection ${entry.name} failed SHA-256 validation.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw new Error(`Benchling registry projection ${entry.name} is not valid JSON.`);
    }
    documents.push(parseBenchlingRegistryProjectionDocument(parsed));
  }
  return documents;
}

async function assertRegularDirectoryPathOrMissing(
  workspacePath: string,
  relativeDirectory: string
): Promise<void> {
  const workspaceStats = await lstat(workspacePath);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error('Benchling migration workspace must be a regular directory.');
  }
  let current = workspacePath;
  for (const segment of relativeDirectory.split('/')) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(
          `Benchling registry projection path contains a non-directory or symlink: ${segment}`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
