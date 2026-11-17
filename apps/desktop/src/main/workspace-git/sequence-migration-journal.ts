import { constants, createReadStream, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
} from '../../db/sequence-package';
import { PAIRED_SIDECAR_SUFFIXES } from '../../db/workspace-content-manifest';
import { syncDirectory } from '../fs-durability';
import { publishFileContentNoClobber } from './exclusive-file-claim';
import {
  assertMigrationPathsAvailable,
  captureMigrationGitContent,
  migrationPathsIntersect,
  type MigrationPathOptions,
} from './migration-paths';
import { relocatePairedSidecars, type MaterializeOptions } from './sequence-package-import';
import { assertPhysicalWriteDestination } from './package-member-boundary';

const DIRECTORY = '.dnaforge-sequence-migrations';
const pathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !path.split(/[\\/]/u).some((part) => part === '..' || part === '' || part === '.') &&
      !path.includes('\0')
  );
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z
  .object({
    schema: z.literal('dnaforge.sequence-migration.v1'),
    source: pathSchema,
    sourceSha256: hashSchema,
    snapshots: z.array(
      z
        .object({
          source: pathSchema,
          file: z.string().regex(/^original(?:-\d+)?$/u),
          sha256: hashSchema,
        })
        .strict()
    ),
  })
  .strict();
const planSchema = z
  .object({
    packageRoot: pathSchema,
    packageId: z.string().min(1),
    productFile: z
      .string()
      .min(1)
      .refine((path) => basename(path) === path && path !== '.' && path !== '..'),
    productSha256: hashSchema,
    packageCount: z.number().int().positive(),
  })
  .strict();
const completionSchema = z
  .object({
    schema: z.literal('dnaforge.sequence-migration-complete.v1'),
    expectedContentSha256: z.record(pathSchema, hashSchema.nullable()),
  })
  .strict();

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function durable(path: string, content: string): Promise<void> {
  await publishFileContentNoClobber(path, content);
  await syncDirectory(dirname(path));
}

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
}

async function packageFiles(root: string): Promise<string[]> {
  const meta = sequencePackagePaths(root).metaPath;
  const document = parseSequencePackageDocument(await fs.readFile(meta, 'utf8'));
  return [
    meta,
    fromPackageRelative(document.product.file, root),
    ...document.members.map((member) => fromPackageRelative(member.path, root)),
  ];
}

async function complete(
  root: string,
  attempt: string,
  packageRoots: readonly string[]
): Promise<Record<string, string | null>> {
  const manifest = manifestSchema.parse(
    JSON.parse(await fs.readFile(join(attempt, 'manifest.json'), 'utf8'))
  );
  const outputs = (await Promise.all(packageRoots.map(packageFiles))).flat();
  const files = (await fs.readdir(attempt))
    .filter(
      (name) =>
        name === 'manifest.json' ||
        /^original(?:-\d+)?$/u.test(name) ||
        /^plan-[a-f0-9-]+\.json$/u.test(name)
    )
    .map((name) => join(attempt, name));
  const content = await captureMigrationGitContent(root, [...outputs, ...files]);
  if (await exists(join(root, manifest.source)))
    throw new Error('The original sequence path is occupied; its migration was not settled.');
  content.expectedContentSha256[manifest.source] = null;
  for (const snapshot of manifest.snapshots) {
    if (!(await exists(join(root, snapshot.source))))
      content.expectedContentSha256[snapshot.source] = null;
  }
  const completionPath = join(attempt, 'complete.json');
  await durable(
    completionPath,
    JSON.stringify({
      schema: 'dnaforge.sequence-migration-complete.v1',
      expectedContentSha256: content.expectedContentSha256,
    })
  );
  const completion = await captureMigrationGitContent(root, [completionPath]);
  return { ...content.expectedContentSha256, ...completion.expectedContentSha256 };
}

export async function prepareSequenceMigration(
  root: string,
  source: string,
  options: MigrationPathOptions
) {
  assertMigrationPathsAvailable([source], options);
  const directory = join(root, DIRECTORY);
  await assertPhysicalWriteDestination(root, directory);
  await fs.mkdir(directory, { recursive: true });
  if (!(await fs.lstat(directory)).isDirectory())
    throw new Error('The sequence migration directory is not a physical directory.');
  const attempt = join(directory, `attempt-${randomUUID()}`);
  await fs.mkdir(attempt);
  const snapshots: z.infer<typeof manifestSchema>['snapshots'] = [];
  const sources = [source, ...PAIRED_SIDECAR_SUFFIXES.map((suffix) => source + suffix)];
  for (const [index, path] of sources.entries()) {
    if (!(await exists(path))) continue;
    assertMigrationPathsAvailable([path], options);
    const before = await fs.stat(path, { bigint: true });
    const file = index === 0 ? 'original' : `original-${index}`;
    const snapshot = join(attempt, file);
    await fs.copyFile(path, snapshot, constants.COPYFILE_EXCL);
    const handle = await fs.open(snapshot, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = await hashFile(snapshot);
    const after = await fs.stat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      sha256 !== (await hashFile(path))
    )
      throw new Error('The sequence changed while its recovery copy was being saved.');
    snapshots.push({ source: relative(root, path).split(sep).join('/'), file, sha256 });
  }
  const sourceSha256 = snapshots[0]?.sha256;
  if (!sourceSha256) throw new Error('The sequence source is missing.');
  await durable(
    join(attempt, 'manifest.json'),
    JSON.stringify({
      schema: 'dnaforge.sequence-migration.v1',
      source: relative(root, source).split(sep).join('/'),
      sourceSha256,
      snapshots,
    })
  );
  const onPackagePlanned: NonNullable<MaterializeOptions['onPackagePlanned']> = async (plan) => {
    options.assertCurrent?.();
    await durable(
      join(attempt, `plan-${randomUUID()}.json`),
      JSON.stringify({
        ...plan,
        packageRoot: relative(root, plan.packageRoot).split(sep).join('/'),
      })
    );
  };
  return {
    expectedSourceSha256: sourceSha256,
    onPackagePlanned,
    finish: (packageRoots: readonly string[]) => complete(root, attempt, packageRoots),
    cancel: async () => {
      await durable(join(attempt, 'cancelled'), 'cancelled');
    },
    cancelIfUnchanged: async () => {
      const plans = await Promise.all(
        (await fs.readdir(attempt))
          .filter((name) => /^plan-[a-f0-9-]+\.json$/u.test(name))
          .map(async (name) =>
            planSchema.parse(JSON.parse(await fs.readFile(join(attempt, name), 'utf8')))
          )
      );
      if (
        (await exists(source)) &&
        (await hashFile(source)) === sourceSha256 &&
        !(await Promise.all(plans.map((plan) => exists(join(root, plan.packageRoot))))).some(
          Boolean
        )
      )
        await durable(join(attempt, 'cancelled'), 'cancelled');
    },
  };
}

export async function collectSequenceMigrationGitContent(
  root: string,
  options: MigrationPathOptions
) {
  const result = {
    expectedContentSha256: {} as Record<string, string | null>,
    failures: [] as Array<{ path: string; message: string }>,
    pendingSources: [] as string[],
    recovered: 0,
  };
  const directory = join(root, DIRECTORY);
  if (!(await exists(directory))) return result;
  if (!(await fs.lstat(directory)).isDirectory())
    throw new Error('The sequence migration directory is not a physical directory.');
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^attempt-[a-f0-9-]+$/u.test(entry.name)) continue;
    const attempt = join(directory, entry.name);
    await assertPhysicalWriteDestination(root, join(attempt, 'manifest.json'));
    if (await exists(join(attempt, 'cancelled'))) continue;
    if (!(await exists(join(attempt, 'manifest.json')))) continue;
    let source = attempt;
    try {
      const manifest = manifestSchema.parse(
        JSON.parse(await fs.readFile(join(attempt, 'manifest.json'), 'utf8'))
      );
      source = join(root, manifest.source);
      const completionPath = join(attempt, 'complete.json');
      if (!(await exists(completionPath))) {
        const plans = await Promise.all(
          (await fs.readdir(attempt))
            .filter((name) => /^plan-[a-f0-9-]+\.json$/u.test(name))
            .map(async (name) =>
              planSchema.parse(JSON.parse(await fs.readFile(join(attempt, name), 'utf8')))
            )
        );
        if (
          plans.length === 0 &&
          (await exists(source)) &&
          (await hashFile(source)) === manifest.sourceSha256
        ) {
          await durable(join(attempt, 'cancelled'), 'cancelled');
          continue;
        }
        for (const path of [
          source,
          ...plans.map((plan) => join(root, plan.packageRoot)),
          ...manifest.snapshots.map((snapshot) => join(root, snapshot.source)),
        ])
          await assertPhysicalWriteDestination(root, path);
        assertMigrationPathsAvailable(
          [source, ...plans.map((plan) => join(root, plan.packageRoot))],
          options
        );
        if (
          plans.length === 0 ||
          plans.some((plan) => plan.packageCount !== plans.length) ||
          (await exists(source))
        )
          throw new Error(
            'An interrupted sequence conversion retained its recovery copy. Its output is incomplete or the original path is occupied.'
          );
        for (const snapshot of manifest.snapshots)
          if ((await hashFile(join(attempt, snapshot.file))) !== snapshot.sha256)
            throw new Error('The retained sequence recovery copy changed.');
        const recover = async () => {
          options.assertCurrent?.();
          for (const plan of plans) {
            const packageRoot = join(root, plan.packageRoot);
            const document = parseSequencePackageDocument(
              await fs.readFile(sequencePackagePaths(packageRoot).metaPath, 'utf8')
            );
            if (
              document.id !== plan.packageId ||
              document.product.file !== plan.productFile ||
              (await hashFile(join(packageRoot, plan.productFile))) !== plan.productSha256
            )
              throw new Error(
                'An interrupted sequence output no longer matches its recorded identity and content.'
              );
          }
          for (const snapshot of manifest.snapshots) {
            const original = join(root, snapshot.source);
            if ((await exists(original)) && (await hashFile(original)) !== snapshot.sha256)
              throw new Error('An attachment changed after sequence conversion and was preserved.');
          }
          if (plans.length === 1)
            await relocatePairedSidecars({
              sourceDir: dirname(source),
              fileName: basename(source),
              destDir: join(root, plans[0].packageRoot),
            });
          await complete(
            root,
            attempt,
            plans.map((plan) => join(root, plan.packageRoot))
          );
        };
        const paths = [
          source,
          ...manifest.snapshots.map((snapshot) => join(root, snapshot.source)),
          ...plans.map((plan) => join(root, plan.packageRoot)),
        ];
        if (options.withCleanPaths) await options.withCleanPaths(paths, recover);
        else await recover();
        result.recovered += 1;
      }
      const completion = completionSchema.parse(
        JSON.parse(await fs.readFile(completionPath, 'utf8'))
      );
      const current = await captureMigrationGitContent(
        root,
        Object.keys(completion.expectedContentSha256).map((path) => join(root, path))
      );
      for (const [path, hash] of Object.entries(completion.expectedContentSha256)) {
        if (
          options.protectedPaths?.some((protectedPath) =>
            migrationPathsIntersect(join(root, path), protectedPath)
          )
        )
          continue;
        if (current.expectedContentSha256[path] === hash) result.expectedContentSha256[path] = hash;
      }
      Object.assign(
        result.expectedContentSha256,
        (await captureMigrationGitContent(root, [completionPath])).expectedContentSha256
      );
    } catch (error) {
      result.pendingSources.push(source);
      result.failures.push({
        path: source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
