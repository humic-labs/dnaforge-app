import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { syncDirectory } from '../fs-durability';
import { claimRegularFileNoClobber, publishFileContentNoClobber } from './exclusive-file-claim';
import { migrationPathsIntersect, type MigrationPathOptions } from './migration-paths';

export const MOLECULAR_MIGRATION_DIRECTORY = '.dnaforge-molecular-migrations';
export type MolecularMigrationKind = 'coordinate' | 'extension-name';
export type MolecularMigrationOptions = MigrationPathOptions;

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const member = z
  .string()
  .min(1)
  .refine((name) => name !== '.' && name !== '..' && !/[\\/\0]/u.test(name));
const identitySchema = z.object({ device: z.string(), inode: z.string() }).strict();
const sourceSchema = identitySchema
  .extend({
    size: z.string(),
    modified: z.string(),
    changed: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const manifestSchema = z
  .object({
    schema: z.literal('dnaforge.molecular-migration.v1'),
    kind: z.enum(['coordinate', 'extension-name']),
    sourceName: member,
    productName: member,
    attempt: z.string().regex(/^attempt-[a-zA-Z0-9]+$/u),
    source: sourceSchema,
    product: identitySchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
type Identity = z.infer<typeof identitySchema>;
const completionSchema = z
  .object({
    schema: z.literal('dnaforge.molecular-migration-complete.v1'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    productSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export interface MolecularMigrationResult {
  productPath: string;
  expectedContentSha256: Record<string, string | null>;
}

function key(kind: MolecularMigrationKind, sourceName: string): string {
  return hash(`${kind}:${sourceName}`);
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function identity(stat: { dev: number | bigint; ino: number | bigint }): Identity {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

async function optionalStat(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function directory(path: string): Promise<void> {
  try {
    await mkdir(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await lstat(path)).isDirectory())
    throw new Error(`MOLECULAR_MIGRATION_DIRECTORY_CHANGED: ${path}`);
}

async function readRegular(
  path: string
): Promise<{ bytes: Buffer; stat: NonNullable<Awaited<ReturnType<typeof optionalStat>>> }> {
  const before = await optionalStat(path);
  if (!before?.isFile()) throw new Error(`MOLECULAR_MIGRATION_SOURCE_NOT_REGULAR: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(opened), identity(before)))
      throw new Error(`MOLECULAR_MIGRATION_SOURCE_CHANGED: ${path}`);
    const bytes = await handle.readFile();
    const after = await optionalStat(path);
    if (
      !after?.isFile() ||
      !sameIdentity(identity(after), identity(before)) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error(`MOLECULAR_MIGRATION_SOURCE_CHANGED: ${path}`);
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}

async function assertFile(path: string, expected: Identity & { sha256: string }): Promise<Buffer> {
  const current = await readRegular(path);
  if (!sameIdentity(identity(current.stat), expected) || hash(current.bytes) !== expected.sha256)
    throw new Error(`MOLECULAR_MIGRATION_FILE_CHANGED: ${path}`);
  return current.bytes;
}

async function assertSource(
  path: string,
  expected: Manifest['source'],
  moved = false
): Promise<void> {
  const current = await readRegular(path);
  if (
    !sameIdentity(identity(current.stat), expected) ||
    String(current.stat.size) !== expected.size ||
    String(current.stat.mtimeNs) !== expected.modified ||
    (!moved && String(current.stat.ctimeNs) !== expected.changed) ||
    hash(current.bytes) !== expected.sha256
  )
    throw new Error(`MOLECULAR_MIGRATION_SOURCE_CHANGED: ${path}`);
}

async function durable(path: string, bytes: string | Uint8Array): Promise<void> {
  await publishFileContentNoClobber(path, bytes);
  await syncDirectory(dirname(path));
}

export function molecularMigrationPathProtected(
  path: string,
  protectedPaths: readonly string[] = []
): boolean {
  return protectedPaths.some((protectedPath) => migrationPathsIntersect(path, protectedPath));
}

export async function pendingMolecularMigrationSources(
  directoryPath: string,
  kind: MolecularMigrationKind
): Promise<string[]> {
  const base = join(directoryPath, MOLECULAR_MIGRATION_DIRECTORY);
  const stat = await optionalStat(base);
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error(`MOLECULAR_MIGRATION_DIRECTORY_CHANGED: ${base}`);
  const sources: string[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const root = join(base, entry.name);
    for (const manifest of await pendingGenerations(root)) {
      if (manifest.kind !== kind) continue;
      if (key(kind, manifest.sourceName) !== entry.name)
        throw new Error(`MOLECULAR_MIGRATION_RECEIPT_CHANGED: ${root}`);
      sources.push(join(directoryPath, manifest.sourceName));
    }
  }
  return sources;
}

export async function collectMolecularMigrationGitContent(
  directoryPath: string,
  kind: MolecularMigrationKind,
  options: MolecularMigrationOptions
): Promise<{
  expectedContentSha256: Record<string, string | null>;
  skipped: Array<{ path: string; reason: string }>;
}> {
  const expectedContentSha256: Record<string, string | null> = {};
  const skipped: Array<{ path: string; reason: string }> = [];
  const base = join(directoryPath, MOLECULAR_MIGRATION_DIRECTORY);
  const stat = await optionalStat(base);
  if (!stat) return { expectedContentSha256, skipped };
  if (!stat.isDirectory()) throw new Error(`MOLECULAR_MIGRATION_DIRECTORY_CHANGED: ${base}`);
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const root = join(base, entry.name);
    for (const generation of await readdir(root, { withFileTypes: true })) {
      if (!generation.isDirectory() || !/^attempt-[a-zA-Z0-9]+$/u.test(generation.name)) continue;
      const attempt = join(root, generation.name);
      const completionPath = join(attempt, 'complete.json');
      if (!(await optionalStat(completionPath))) continue;
      try {
        const manifestPath = join(attempt, 'manifest.json');
        const manifestBytes = (await readRegular(manifestPath)).bytes;
        const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
        if (manifest.kind !== kind) continue;
        const completionBytes = (await readRegular(completionPath)).bytes;
        const completion = completionSchema.parse(JSON.parse(completionBytes.toString('utf8')));
        if (
          manifest.attempt !== generation.name ||
          key(kind, manifest.sourceName) !== entry.name ||
          completion.sourceSha256 !== manifest.source.sha256 ||
          completion.productSha256 !== manifest.product.sha256
        )
          throw new Error(`MOLECULAR_MIGRATION_RECEIPT_CHANGED: ${attempt}`);
        const pins: Record<string, string | null> = {
          [manifestPath]: hash(manifestBytes),
          [completionPath]: hash(completionBytes),
        };
        for (const [name, sha256] of [
          ['original', manifest.source.sha256],
          ['product', manifest.product.sha256],
          [`source-${manifest.sourceName}`, manifest.source.sha256],
        ]) {
          const path = join(attempt, name);
          if (hash((await readRegular(path)).bytes) === sha256) pins[path] = sha256;
        }
        const productPath = join(directoryPath, manifest.productName);
        if (await optionalStat(productPath)) {
          try {
            if (hash((await readRegular(productPath)).bytes) === manifest.product.sha256)
              pins[productPath] = manifest.product.sha256;
          } catch {}
        }
        const sourcePath = join(directoryPath, manifest.sourceName);
        if (!(await optionalStat(sourcePath))) pins[sourcePath] = null;
        for (const [path, sha256] of Object.entries(pins)) {
          if (!molecularMigrationPathProtected(path, options.protectedPaths))
            expectedContentSha256[path] = sha256;
        }
      } catch (error) {
        skipped.push({
          path: attempt,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { expectedContentSha256, skipped };
}

async function pendingGenerations(root: string): Promise<Manifest[]> {
  const pending: Manifest[] = [];
  for (const generation of await readdir(root, { withFileTypes: true })) {
    if (!generation.isDirectory() || !/^attempt-[a-zA-Z0-9]+$/u.test(generation.name)) continue;
    const path = join(root, generation.name);
    if (await optionalStat(join(path, 'complete.json'))) continue;
    const manifestPath = join(path, 'manifest.json');
    if (!(await optionalStat(manifestPath))) continue;
    const manifest = manifestSchema.parse(
      JSON.parse((await readRegular(manifestPath)).bytes.toString('utf8'))
    );
    if (manifest.attempt !== generation.name)
      throw new Error(`MOLECULAR_MIGRATION_RECEIPT_CHANGED: ${path}`);
    pending.push(manifest);
  }
  return pending;
}

export async function settleCompletedMolecularMigrationLinks(
  rootPath: string,
  options: { scope: 'unpublished-compute-staging'; assertCurrent?: () => void }
): Promise<void> {
  if (options.scope !== 'unpublished-compute-staging')
    throw new Error('MOLECULAR_MIGRATION_STAGING_REQUIRED');
  const settle = async (attempt: string, parent: string) => {
    const manifestPath = join(attempt, 'manifest.json');
    const manifest = manifestSchema.parse(
      JSON.parse((await readRegular(manifestPath)).bytes.toString('utf8'))
    );
    const completion = completionSchema.parse(
      JSON.parse((await readRegular(join(attempt, 'complete.json'))).bytes.toString('utf8'))
    );
    if (
      manifest.attempt !== basename(attempt) ||
      key(manifest.kind, manifest.sourceName) !== basename(dirname(attempt)) ||
      completion.sourceSha256 !== manifest.source.sha256 ||
      completion.productSha256 !== manifest.product.sha256
    )
      throw new Error(`MOLECULAR_MIGRATION_RECEIPT_CHANGED: ${attempt}`);
    const stagedPath = join(attempt, 'product');
    const productPath = join(parent, manifest.productName);
    const staged = await readRegular(stagedPath);
    if (hash(staged.bytes) !== manifest.product.sha256)
      throw new Error(`MOLECULAR_MIGRATION_FILE_CHANGED: ${stagedPath}`);
    await assertFile(productPath, manifest.product);
    if (!sameIdentity(identity(staged.stat), manifest.product)) {
      if (staged.stat.nlink !== 1n)
        throw new Error(`MOLECULAR_MIGRATION_FILE_CHANGED: ${stagedPath}`);
      return;
    }
    const temporary = await mkdtemp(join(attempt, '.detach-'));
    const copyPath = join(temporary, 'product');
    let copyIdentity: Identity | undefined;
    try {
      await durable(copyPath, staged.bytes);
      const copy = await readRegular(copyPath);
      copyIdentity = identity(copy.stat);
      if (hash(copy.bytes) !== manifest.product.sha256)
        throw new Error(`MOLECULAR_MIGRATION_FILE_CHANGED: ${copyPath}`);
      await assertFile(stagedPath, manifest.product);
      await assertFile(productPath, manifest.product);
      options.assertCurrent?.();
      await rename(copyPath, stagedPath);
      await syncDirectory(attempt);
    } finally {
      const remaining = await optionalStat(copyPath);
      if (remaining && copyIdentity && sameIdentity(identity(remaining), copyIdentity))
        await unlink(copyPath);
      await rmdir(temporary);
    }
  };
  const walk = async (directory: string): Promise<void> => {
    options.assertCurrent?.();
    if (!(await lstat(directory)).isDirectory())
      throw new Error(`MOLECULAR_MIGRATION_DIRECTORY_CHANGED: ${directory}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name !== MOLECULAR_MIGRATION_DIRECTORY) {
        await walk(path);
        continue;
      }
      for (const source of await readdir(path, { withFileTypes: true })) {
        if (!source.isDirectory() || !/^[a-f0-9]{64}$/u.test(source.name)) continue;
        const root = join(path, source.name);
        for (const generation of await readdir(root, { withFileTypes: true })) {
          if (!generation.isDirectory() || !/^attempt-[a-zA-Z0-9]+$/u.test(generation.name))
            continue;
          const attempt = join(root, generation.name);
          if (await optionalStat(join(attempt, 'complete.json'))) await settle(attempt, directory);
        }
      }
    }
  };
  await walk(rootPath);
}

export async function migrateMolecularFile(
  requestedPath: string,
  kind: MolecularMigrationKind,
  prepare: (bytes: Buffer) => Promise<{ content: string; productNames: readonly string[] }>,
  options: MolecularMigrationOptions & { removeSource: (path: string) => Promise<unknown> }
): Promise<MolecularMigrationResult> {
  options.assertCurrent?.();
  if (molecularMigrationPathProtected(requestedPath, options.protectedPaths))
    throw new Error(`MOLECULAR_MIGRATION_PROTECTED_PATH: ${requestedPath}`);
  const operation = () =>
    migrateMolecularFileWithinCleanSource(requestedPath, kind, prepare, options);
  return options.withCleanPaths ? options.withCleanPaths([requestedPath], operation) : operation();
}

async function migrateMolecularFileWithinCleanSource(
  requestedPath: string,
  kind: MolecularMigrationKind,
  prepare: (bytes: Buffer) => Promise<{ content: string; productNames: readonly string[] }>,
  options: MolecularMigrationOptions & { removeSource: (path: string) => Promise<unknown> }
): Promise<MolecularMigrationResult> {
  const parent = resolve(dirname(requestedPath));
  const sourcePath = join(parent, basename(requestedPath));
  const base = join(parent, MOLECULAR_MIGRATION_DIRECTORY);
  const root = join(base, key(kind, basename(sourcePath)));
  const assertCurrent = () => {
    options.assertCurrent?.();
    if (molecularMigrationPathProtected(sourcePath, options.protectedPaths))
      throw new Error(`MOLECULAR_MIGRATION_PROTECTED_PATH: ${sourcePath}`);
  };
  assertCurrent();
  await directory(base);
  await directory(root);
  let compromised: Error | undefined;
  const release = await lockfile.lock(join(root, 'active'), {
    realpath: false,
    stale: 2000,
    update: 1000,
    retries: { retries: 30, minTimeout: 100, maxTimeout: 100 },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  const assertAuthority = () => {
    assertCurrent();
    if (compromised) throw compromised;
  };
  try {
    assertAuthority();
    let manifest: Manifest;
    const pending = await pendingGenerations(root);
    if (pending.length > 1) throw new Error(`MOLECULAR_MIGRATION_PENDING_AMBIGUOUS: ${root}`);
    if (pending.length === 1) {
      manifest = pending[0];
      if (manifest.kind !== kind || manifest.sourceName !== basename(sourcePath))
        throw new Error(`MOLECULAR_MIGRATION_RECEIPT_CHANGED: ${root}`);
    } else {
      const original = await readRegular(sourcePath);
      const prepared = await prepare(original.bytes);
      const source: Manifest['source'] = {
        ...identity(original.stat),
        size: String(original.stat.size),
        modified: String(original.stat.mtimeNs),
        changed: String(original.stat.ctimeNs),
        sha256: hash(original.bytes),
      };
      await assertSource(sourcePath, source);
      let productName: string | undefined;
      for (const name of prepared.productNames) {
        member.parse(name);
        if (molecularMigrationPathProtected(join(parent, name), options.protectedPaths)) continue;
        if (!(await optionalStat(join(parent, name)))) {
          productName = name;
          break;
        }
      }
      if (!productName) throw new Error(`No free molecular view name beside ${sourcePath}.`);
      assertAuthority();
      const attempt = await mkdtemp(join(root, 'attempt-'));
      await syncDirectory(root);
      await durable(join(attempt, 'original'), original.bytes);
      await durable(join(attempt, 'product'), prepared.content);
      const product = await readRegular(join(attempt, 'product'));
      manifest = {
        schema: 'dnaforge.molecular-migration.v1',
        kind,
        sourceName: basename(sourcePath),
        productName,
        attempt: basename(attempt),
        source,
        product: { ...identity(product.stat), sha256: hash(product.bytes) },
      };
      assertAuthority();
      await assertSource(sourcePath, source);
      await durable(join(attempt, 'manifest.json'), JSON.stringify(manifest));
    }
    const attempt = join(root, manifest.attempt);
    const manifestPath = join(attempt, 'manifest.json');
    if (!(await lstat(attempt)).isDirectory())
      throw new Error(`MOLECULAR_MIGRATION_DIRECTORY_CHANGED: ${attempt}`);
    const productPath = join(parent, manifest.productName);
    if (molecularMigrationPathProtected(productPath, options.protectedPaths))
      throw new Error(`MOLECULAR_MIGRATION_PROTECTED_PATH: ${productPath}`);
    const operation = async (): Promise<MolecularMigrationResult> => {
      assertAuthority();
      const retainedPath = join(attempt, `source-${manifest.sourceName}`);
      const retiringPath = join(attempt, `retiring-${manifest.sourceName}`);
      const stagedProduct = join(attempt, 'product');
      const stagedBytes = await assertFile(stagedProduct, manifest.product);
      if (
        kind === 'extension-name' &&
        options.protectedEntityIds?.has(JSON.parse(stagedBytes.toString('utf8')).id)
      )
        throw new Error('MOLECULAR_MIGRATION_IDENTITY_OWNED');
      const original = await readRegular(join(attempt, 'original'));
      if (hash(original.bytes) !== manifest.source.sha256)
        throw new Error(`MOLECULAR_MIGRATION_ORIGINAL_CHANGED: ${attempt}`);
      if (await optionalStat(join(attempt, 'complete.json')))
        throw new Error(`MOLECULAR_MIGRATION_COMPLETION_CHANGED: ${attempt}`);
      if (await optionalStat(retainedPath)) {
        await assertSource(retainedPath, manifest.source, true);
        if (await optionalStat(sourcePath))
          throw new Error(`MOLECULAR_MIGRATION_SOURCE_REAPPEARED: ${sourcePath}`);
      } else {
        await assertSource(sourcePath, manifest.source);
      }
      assertAuthority();
      if (!(await optionalStat(productPath))) {
        await claimRegularFileNoClobber(stagedProduct, productPath, {
          open: async () => {
            throw new Error('MOLECULAR_MIGRATION_HARD_LINK_REQUIRED');
          },
        });
        await syncDirectory(parent);
      }
      await assertFile(productPath, manifest.product);
      if (!(await optionalStat(retainedPath))) {
        await assertSource(sourcePath, manifest.source);
        assertAuthority();
        await rename(sourcePath, retainedPath);
        await Promise.all([syncDirectory(parent), syncDirectory(attempt)]);
        try {
          await assertSource(retainedPath, manifest.source, true);
        } catch (error) {
          await link(retainedPath, sourcePath).catch(() => undefined);
          throw error;
        }
      }
      await assertSource(retainedPath, manifest.source, true);
      if (!(await optionalStat(retiringPath))) {
        assertAuthority();
        await link(retainedPath, retiringPath);
        await syncDirectory(attempt);
      }
      await assertSource(retiringPath, manifest.source, true);
      await assertFile(productPath, manifest.product);
      assertAuthority();
      await options.removeSource(retiringPath);
      if (await optionalStat(retiringPath))
        throw new Error(`MOLECULAR_MIGRATION_RETIREMENT_INCOMPLETE: ${retiringPath}`);
      await assertSource(retainedPath, manifest.source, true);
      await assertFile(productPath, manifest.product);
      assertAuthority();
      await durable(
        join(attempt, 'complete.json'),
        JSON.stringify({
          schema: 'dnaforge.molecular-migration-complete.v1',
          sourceSha256: manifest.source.sha256,
          productSha256: manifest.product.sha256,
        })
      );
      const expectedContentSha256: Record<string, string | null> = {
        [sourcePath]: null,
        [productPath]: manifest.product.sha256,
      };
      for (const path of [
        manifestPath,
        join(attempt, 'complete.json'),
        join(attempt, 'original'),
        stagedProduct,
        retainedPath,
      ]) {
        const file = await readRegular(path);
        expectedContentSha256[path] = hash(file.bytes);
      }
      return { productPath, expectedContentSha256 };
    };
    return options.withCleanPaths
      ? await options.withCleanPaths([productPath], operation)
      : await operation();
  } finally {
    await release();
  }
}
