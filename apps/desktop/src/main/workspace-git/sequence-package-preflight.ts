import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  loadSequencePackageDocument,
  type SequencePackageIoFs,
} from '../../db/sequence-package-io';
import {
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  SEQUENCE_PACKAGE_META_ALIASES,
  parseSequencePackageDocument,
} from '../../db/sequence-package';
import { writeWorkspaceTextFileAtomicInMain } from '../primer-artifact-files';
import { syncDirectory } from '../fs-durability';
import { isRecoveredComputeResultDirectory } from '../../shared/compute-result-path';
import {
  assertPhysicalWriteDestination,
  assertPhysicalPackageMember,
} from './package-member-boundary';
import { claimRegularFileNoClobber, publishFileContentNoClobber } from './exclusive-file-claim';
import {
  assertMigrationPathsAvailable,
  captureMigrationGitContent,
  migrationPathsIntersect,
  type MigrationPathOptions,
} from './migration-paths';
import { SEQUENCE_UPGRADE_DIRECTORY as DIRECTORY } from '../../shared/sequence-migration-path';

const digest = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..') &&
      !path.includes('\0')
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z
  .object({
    schema: z.literal('dnaforge.sequence-upgrade.v1'),
    marker: relativePath,
    beforeSha256: hash,
  })
  .strict();
const stepSchema = z.record(relativePath, hash.nullable());

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
}

async function durable(path: string, text: string): Promise<void> {
  await publishFileContentNoClobber(path, text);
  await syncDirectory(dirname(path));
}

async function readSteps(directory: string) {
  const files = (await fs.readdir(directory))
    .filter((name) => /^step-\d{6}\.json$/u.test(name))
    .sort();
  const expected: Record<string, string | null> = {};
  for (const name of files)
    Object.assign(
      expected,
      stepSchema.parse(JSON.parse(await fs.readFile(join(directory, name), 'utf8')))
    );
  return { expected, next: files.length, files: files.map((name) => join(directory, name)) };
}

async function upgrade(root: string, marker: string, options: MigrationPathOptions) {
  const before = await fs.readFile(marker, 'utf8');
  const markerRelative = relative(root, marker).split(sep).join('/');
  const directory = join(root, DIRECTORY, digest(markerRelative), digest(before));
  await assertPhysicalWriteDestination(root, directory);
  await fs.mkdir(directory, { recursive: true });
  await assertPhysicalWriteDestination(root, join(directory, 'manifest.json'));
  if (!(await exists(join(directory, 'manifest.json')))) {
    const original = join(directory, 'original.json');
    if (await exists(original)) {
      if ((await fs.readFile(original, 'utf8')) !== before)
        throw new Error('The retained sequence package marker differs from the expected source.');
    } else await durable(original, before);
    await durable(
      join(directory, 'manifest.json'),
      JSON.stringify({
        schema: 'dnaforge.sequence-upgrade.v1',
        marker: markerRelative,
        beforeSha256: digest(before),
      })
    );
  }
  const previous = await readSteps(directory);
  let step = previous.next;
  let changed = false;
  const record = async (paths: Record<string, string | null>) => {
    options.assertCurrent?.();
    await durable(
      join(directory, `step-${String(step++).padStart(6, '0')}.json`),
      JSON.stringify(paths)
    );
    changed = true;
  };
  const checked = async (path: string) => {
    assertMigrationPathsAvailable([path], options);
    await assertPhysicalWriteDestination(root, path);
    if ((await fs.readFile(marker, 'utf8')) !== before)
      throw new Error('The sequence package changed while its migration was being prepared.');
  };
  const rename = async (source: string, destination: string) => {
    await checked(source);
    await checked(destination);
    const sourceHash = (await captureMigrationGitContent(root, [source])).expectedContentSha256[
      relative(root, source).split(sep).join('/')
    ];
    if (!sourceHash) throw new Error('A sequence package migration member is missing.');
    await record({
      [relative(root, source).split(sep).join('/')]: null,
      [relative(root, destination).split(sep).join('/')]: sourceHash,
    });
    const beforeSource = await fs.lstat(source);
    await claimRegularFileNoClobber(source, destination);
    const current = await fs.lstat(source);
    if (beforeSource.dev !== current.dev || beforeSource.ino !== current.ino)
      throw new Error('The sequence package member changed before migration could retire it.');
    options.assertCurrent?.();
    await fs.unlink(source);
  };
  const adapter: SequencePackageIoFs = {
    exists,
    readTextFile: (path) => fs.readFile(path, 'utf8'),
    readFile: (path) => fs.readFile(path),
    writeTextFile: async () => {
      throw new Error('Sequence package preflight requires its admitted marker writer.');
    },
    writeWorkspaceTextFileAtomic: async (input) => {
      await checked(input.path);
      if (input.workspaceRoot !== root || input.path !== marker)
        throw new Error('Sequence upgrade changed its owning marker.');
      await record({ [markerRelative]: digest(input.content) });
      return writeWorkspaceTextFileAtomicInMain(input, {
        durable: true,
        beforePublish: options.assertCurrent,
      });
    },
    mkdir: async (path, mkdirOptions) => {
      await checked(path);
      await fs.mkdir(path, mkdirOptions);
    },
    rename,
    move: async (source, destinationDirectory) => {
      const destPath = join(destinationDirectory, basename(source));
      await rename(source, destPath);
      return { destPath };
    },
    unlink: async (path) => {
      await checked(path);
      await record({ [relative(root, path).split(sep).join('/')]: null });
      await fs.unlink(path);
    },
  };
  await loadSequencePackageDocument(dirname(dirname(marker)), adapter, root);
  return changed;
}

export async function preflightLegacySequencePackages(
  root: string,
  options: MigrationPathOptions & { packageIdForPath?: (path: string) => string | undefined } = {}
) {
  const result = {
    upgraded: 0,
    failures: [] as Array<{ path: string; message: string }>,
    expectedContentSha256: {} as Record<string, string | null>,
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 40)
      throw new Error('Sequence package discovery exceeded the supported directory depth.');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === '.forge' && entry.isDirectory())) {
      for (const name of SEQUENCE_PACKAGE_META_ALIASES) {
        const marker = join(directory, '.forge', name);
        if (!(await exists(marker))) continue;
        if (options.protectedPaths?.some((path) => migrationPathsIntersect(directory, path)))
          return;
        try {
          await assertPhysicalPackageMember(root, marker);
          const text = await fs.readFile(marker, 'utf8');
          const raw = JSON.parse(text) as { formatVersion?: number };
          const document = parseSequencePackageDocument(text);
          if (options.protectedEntityIds?.has(document.id)) return;
          const id = options.packageIdForPath?.(marker) ?? options.packageIdForPath?.(directory);
          if (id && id !== document.id)
            throw new Error(
              'The sequence package identity differs from its current catalog binding.'
            );
          if (raw.formatVersion === SEQUENCE_PACKAGE_FORMAT_VERSION) return;
          const run = async () => {
            assertMigrationPathsAvailable([directory], options);
            return upgrade(root, marker, options);
          };
          const changed = options.withCleanPaths
            ? await options.withCleanPaths([directory], run)
            : await run();
          if (changed) result.upgraded += 1;
        } catch (error) {
          result.failures.push({
            path: marker,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      for (const name of ['notebook.json', 'protocol.json', 'protocol-run.json'])
        if (await exists(join(directory, '.forge', name))) return;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        !(
          depth === 0 &&
          (entry.name === 'compute' ||
            entry.name === 'test-fixtures' ||
            isRecoveredComputeResultDirectory(entry.name))
        )
      )
        await walk(join(directory, entry.name), depth + 1);
  };
  await walk(root, 0);
  const receiptRoot = join(root, DIRECTORY);
  if (!(await exists(receiptRoot))) return result;
  await assertPhysicalWriteDestination(root, join(receiptRoot, 'witness'));
  for (const key of await fs.readdir(receiptRoot, { withFileTypes: true })) {
    if (!key.isDirectory() || !/^[a-f0-9]{64}$/u.test(key.name)) continue;
    for (const generation of await fs.readdir(join(receiptRoot, key.name), {
      withFileTypes: true,
    })) {
      if (!generation.isDirectory() || !/^[a-f0-9]{64}$/u.test(generation.name)) continue;
      const directory = join(receiptRoot, key.name, generation.name);
      try {
        const manifest = manifestSchema.parse(
          JSON.parse(await fs.readFile(join(directory, 'manifest.json'), 'utf8'))
        );
        if (
          options.protectedPaths?.some((path) =>
            migrationPathsIntersect(join(root, manifest.marker), path)
          )
        )
          continue;
        const steps = await readSteps(directory);
        if (!steps.expected[manifest.marker]) continue;
        const current = await captureMigrationGitContent(
          root,
          Object.keys(steps.expected).map((path) => join(root, path))
        );
        if (
          Object.entries(steps.expected).some(
            ([path, hash]) => current.expectedContentSha256[path] !== hash
          )
        )
          continue;
        const document = parseSequencePackageDocument(
          await fs.readFile(join(root, manifest.marker), 'utf8')
        );
        if (options.protectedEntityIds?.has(document.id)) continue;
        if (digest(await fs.readFile(join(directory, 'original.json'))) !== manifest.beforeSha256)
          throw new Error('The retained sequence package marker changed.');
        Object.assign(
          result.expectedContentSha256,
          steps.expected,
          (
            await captureMigrationGitContent(root, [
              ...steps.files,
              join(directory, 'original.json'),
              join(directory, 'manifest.json'),
            ])
          ).expectedContentSha256
        );
      } catch (error) {
        result.failures.push({
          path: directory,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}
