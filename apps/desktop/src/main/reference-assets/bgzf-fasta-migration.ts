import { createHash } from 'node:crypto';
import { createReadStream, existsSync, constants as fsConstants } from 'node:fs';
import { access, chmod, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { execDnaIndexerFile } from './dna-indexer-process';
import { isBgzfFile } from './reference-preparation-file-integrity';

export const BGZF_FASTA_MIGRATION_RECEIPT_V1 = 'dnaforge-bgzf-fasta-migration.v1' as const;
export const BGZF_FASTA_MIGRATION_RECEIPT_FILE = 'dnaforge-bgzf-fasta-migration.v1.json';
export const DNA_INDEXER_COMPRESS_FASTA_TIMEOUT_MS = 5 * 60 * 1_000;

const SHA256 = /^[0-9a-f]{64}$/;
const inflight = new Map<string, Promise<BgzfFastaMigrationResult>>();
let configuredIndexerBinary: string | undefined;

export interface BgzfFastaMigrationReceiptV1 {
  readonly contract: typeof BGZF_FASTA_MIGRATION_RECEIPT_V1;
  readonly source: Readonly<{
    fastaRelPath: string;
    fastaSha256: string;
    fastaByteLength: number;
    faiRelPath: string;
    faiSha256: string;
    faiByteLength: number;
  }>;
  readonly product: Readonly<{
    fastaRelPath: string;
    fastaSha256: string;
    fastaByteLength: number;
    faiRelPath: string;
    faiSha256: string;
    faiByteLength: number;
    gziRelPath: string;
    gziSha256: string;
    gziByteLength: number;
  }>;
}

export interface BgzfFastaMigrationResult {
  readonly alreadyMigrated: boolean;
  readonly receiptPath: string;
  readonly uncompressedFastaPath: string;
  readonly product: Readonly<{
    fastaPath: string;
    faiPath: string;
    gziPath: string;
  }>;
  readonly receipt: BgzfFastaMigrationReceiptV1;
}

export interface MigrateUncompressedFastaBundleInput {
  readonly uncompressedFastaPath: string;
  readonly indexerBinary?: string;
  readonly compress?: (fastaPath: string) => Promise<void>;
  readonly timeoutMs?: number;
}

export interface HostedFastaMigrationObject {
  readonly id: string;
  readonly role: string;
  readonly installPath: string;
  readonly sha256: string;
}

export function clearBgzfFastaMigrationInflightForTests(): void {
  inflight.clear();
}

export function setBgzfFastaMigrationIndexerBinary(path: string): void {
  configuredIndexerBinary = path;
}

export function uncompressedFastaPathFor(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.fa.gz') || lower.endsWith('.fasta.gz') || lower.endsWith('.fna.gz')) {
    return path.slice(0, -3);
  }
  if (lower.endsWith('.fa') || lower.endsWith('.fasta') || lower.endsWith('.fna')) {
    return path;
  }
  return null;
}

export function bgzfFastaProductPaths(uncompressedFastaPath: string): {
  readonly fastaPath: string;
  readonly faiPath: string;
  readonly gziPath: string;
  readonly uncompressedFaiPath: string;
  readonly receiptPath: string;
} {
  return {
    fastaPath: `${uncompressedFastaPath}.gz`,
    faiPath: `${uncompressedFastaPath}.gz.fai`,
    gziPath: `${uncompressedFastaPath}.gz.gzi`,
    uncompressedFaiPath: `${uncompressedFastaPath}.fai`,
    receiptPath: join(dirname(uncompressedFastaPath), BGZF_FASTA_MIGRATION_RECEIPT_FILE),
  };
}

export function isUncompressedPreparedFastaInstallPath(installPath: string): boolean {
  return /^prepared\/[^/]+\/[^/]+\.fa$/.test(normalizeInstallPath(installPath));
}

export function isUncompressedPreparedFastaIndexInstallPath(installPath: string): boolean {
  return /^prepared\/[^/]+\/[^/]+\.fa\.fai$/.test(normalizeInstallPath(installPath));
}

export async function migrateUncompressedFastaBundle(
  input: MigrateUncompressedFastaBundleInput
): Promise<BgzfFastaMigrationResult> {
  const uncompressedFastaPath = resolve(input.uncompressedFastaPath);
  const existing = inflight.get(uncompressedFastaPath);
  if (existing) return existing;
  const created = migrateUncompressedFastaBundleUncached({
    ...input,
    uncompressedFastaPath,
  }).finally(() => {
    if (inflight.get(uncompressedFastaPath) === created) inflight.delete(uncompressedFastaPath);
  });
  inflight.set(uncompressedFastaPath, created);
  return created;
}

export async function readValidBgzfFastaMigrationReceipt(
  directory: string
): Promise<BgzfFastaMigrationReceiptV1 | null> {
  const receiptPath = join(directory, BGZF_FASTA_MIGRATION_RECEIPT_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
  } catch {
    return null;
  }
  const receipt = parseBgzfFastaMigrationReceipt(parsed);
  if (!receipt) return null;
  const products = productAbsolutePaths(directory, receipt);
  if (!(await regularNonEmptyFile(products.fastaPath))) return null;
  if (!(await regularNonEmptyFile(products.faiPath))) return null;
  if (!(await regularNonEmptyFile(products.gziPath))) return null;
  return receipt;
}

export async function hostedObjectSatisfiedByBgzfFastaMigration(input: {
  readonly generationRoot: string;
  readonly object: HostedFastaMigrationObject;
}): Promise<boolean> {
  if (input.object.role !== 'fasta' && input.object.role !== 'fasta-index') return false;
  const installPath = normalizeInstallPath(input.object.installPath);
  if (
    (input.object.role === 'fasta' && !isUncompressedPreparedFastaInstallPath(installPath)) ||
    (input.object.role === 'fasta-index' &&
      !isUncompressedPreparedFastaIndexInstallPath(installPath))
  ) {
    return false;
  }
  const directory = resolve(input.generationRoot, dirname(installPath));
  assertAtOrBelow(input.generationRoot, directory, 'BGZF FASTA migration receipt');
  const receipt = await readValidBgzfFastaMigrationReceipt(directory);
  if (!receipt) return false;
  if (input.object.role === 'fasta' && receipt.source.fastaSha256 !== input.object.sha256) {
    return false;
  }
  if (input.object.role === 'fasta-index' && receipt.source.faiSha256 !== input.object.sha256) {
    return false;
  }
  return true;
}

async function migrateUncompressedFastaBundleUncached(
  input: MigrateUncompressedFastaBundleInput & { uncompressedFastaPath: string }
): Promise<BgzfFastaMigrationResult> {
  const uncompressedFastaPath = input.uncompressedFastaPath;
  const products = bgzfFastaProductPaths(uncompressedFastaPath);
  const directory = dirname(uncompressedFastaPath);
  const existingReceipt = await readValidBgzfFastaMigrationReceipt(directory);
  const originalsPresent =
    (await regularNonEmptyFile(uncompressedFastaPath)) &&
    (await regularNonEmptyFile(products.uncompressedFaiPath));
  if (existingReceipt && !originalsPresent) {
    return {
      alreadyMigrated: true,
      receiptPath: products.receiptPath,
      uncompressedFastaPath,
      product: {
        fastaPath: products.fastaPath,
        faiPath: products.faiPath,
        gziPath: products.gziPath,
      },
      receipt: existingReceipt,
    };
  }
  if (!originalsPresent) {
    throw new Error(`Cannot migrate missing uncompressed FASTA bundle: ${uncompressedFastaPath}`);
  }

  const productsReady = await productsMatchOriginalFai(products);
  if (!productsReady) {
    if (input.compress) {
      await input.compress(uncompressedFastaPath);
    } else {
      const binary = await resolveCompressFastaBinary(input.indexerBinary);
      await execDnaIndexerFile(
        binary,
        ['compress-fasta', '--in', uncompressedFastaPath],
        input.timeoutMs ?? DNA_INDEXER_COMPRESS_FASTA_TIMEOUT_MS
      );
    }
  }
  if (!(await productsMatchOriginalFai(products))) {
    throw new Error(
      `BGZF FASTA migration did not produce a matching index for ${uncompressedFastaPath}.`
    );
  }
  if (!(await isBgzfFile(products.fastaPath))) {
    throw new Error(`BGZF FASTA migration product is not BGZF: ${products.fastaPath}`);
  }

  const sourceFasta = await fileIdentity(uncompressedFastaPath);
  const sourceFai = await fileIdentity(products.uncompressedFaiPath);
  const productFasta = await fileIdentity(products.fastaPath);
  const productFai = await fileIdentity(products.faiPath);
  const productGzi = await fileIdentity(products.gziPath);
  if (productFai.sha256 !== sourceFai.sha256) {
    throw new Error(`BGZF FASTA migration changed FASTA index bytes for ${uncompressedFastaPath}.`);
  }
  const receipt: BgzfFastaMigrationReceiptV1 = {
    contract: BGZF_FASTA_MIGRATION_RECEIPT_V1,
    source: {
      fastaRelPath: basename(uncompressedFastaPath),
      fastaSha256: sourceFasta.sha256,
      fastaByteLength: sourceFasta.byteLength,
      faiRelPath: basename(products.uncompressedFaiPath),
      faiSha256: sourceFai.sha256,
      faiByteLength: sourceFai.byteLength,
    },
    product: {
      fastaRelPath: basename(products.fastaPath),
      fastaSha256: productFasta.sha256,
      fastaByteLength: productFasta.byteLength,
      faiRelPath: basename(products.faiPath),
      faiSha256: productFai.sha256,
      faiByteLength: productFai.byteLength,
      gziRelPath: basename(products.gziPath),
      gziSha256: productGzi.sha256,
      gziByteLength: productGzi.byteLength,
    },
  };
  await writeReceipt(products.receiptPath, receipt);
  await unlinkOriginal(uncompressedFastaPath);
  await unlinkOriginal(products.uncompressedFaiPath);
  return {
    alreadyMigrated: false,
    receiptPath: products.receiptPath,
    uncompressedFastaPath,
    product: {
      fastaPath: products.fastaPath,
      faiPath: products.faiPath,
      gziPath: products.gziPath,
    },
    receipt,
  };
}

function parseBgzfFastaMigrationReceipt(value: unknown): BgzfFastaMigrationReceiptV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).sort().join(',') !== 'contract,product,source' ||
    root.contract !== BGZF_FASTA_MIGRATION_RECEIPT_V1
  ) {
    return null;
  }
  const source = parseIdentitySide(root.source, ['fastaRelPath', 'faiRelPath']);
  const product = parseIdentitySide(root.product, ['fastaRelPath', 'faiRelPath', 'gziRelPath']);
  if (!source || !product || !('gziRelPath' in product) || !('gziSha256' in product)) return null;
  const productRecord = product as BgzfFastaMigrationReceiptV1['product'];
  if (
    !isBasename(source.fastaRelPath) ||
    !isBasename(source.faiRelPath) ||
    !isBasename(productRecord.fastaRelPath) ||
    !isBasename(productRecord.faiRelPath) ||
    !isBasename(productRecord.gziRelPath)
  ) {
    return null;
  }
  return {
    contract: BGZF_FASTA_MIGRATION_RECEIPT_V1,
    source,
    product: productRecord,
  };
}

function parseIdentitySide(
  value: unknown,
  relKeys: readonly string[]
): {
  fastaRelPath: string;
  fastaSha256: string;
  fastaByteLength: number;
  faiRelPath: string;
  faiSha256: string;
  faiByteLength: number;
  gziRelPath?: string;
  gziSha256?: string;
  gziByteLength?: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    ...relKeys,
    ...relKeys.flatMap((key) => {
      const stem = key.replace(/RelPath$/, '');
      return [`${stem}Sha256`, `${stem}ByteLength`];
    }),
  ].sort();
  if (Object.keys(record).sort().join(',') !== expectedKeys.join(',')) return null;
  const fastaRelPath = requireBasename(record.fastaRelPath);
  const faiRelPath = requireBasename(record.faiRelPath);
  const fastaSha256 = requireSha256(record.fastaSha256);
  const faiSha256 = requireSha256(record.faiSha256);
  const fastaByteLength = requirePositiveInteger(record.fastaByteLength);
  const faiByteLength = requirePositiveInteger(record.faiByteLength);
  if (
    fastaRelPath === null ||
    faiRelPath === null ||
    fastaSha256 === null ||
    faiSha256 === null ||
    fastaByteLength === null ||
    faiByteLength === null
  ) {
    return null;
  }
  if (!relKeys.includes('gziRelPath')) {
    return {
      fastaRelPath,
      fastaSha256,
      fastaByteLength,
      faiRelPath,
      faiSha256,
      faiByteLength,
    };
  }
  const gziRelPath = requireBasename(record.gziRelPath);
  const gziSha256 = requireSha256(record.gziSha256);
  const gziByteLength = requirePositiveInteger(record.gziByteLength);
  if (gziRelPath === null || gziSha256 === null || gziByteLength === null) return null;
  return {
    fastaRelPath,
    fastaSha256,
    fastaByteLength,
    faiRelPath,
    faiSha256,
    faiByteLength,
    gziRelPath,
    gziSha256,
    gziByteLength,
  };
}

function productAbsolutePaths(
  directory: string,
  receipt: BgzfFastaMigrationReceiptV1
): { fastaPath: string; faiPath: string; gziPath: string } {
  return {
    fastaPath: join(directory, receipt.product.fastaRelPath),
    faiPath: join(directory, receipt.product.faiRelPath),
    gziPath: join(directory, receipt.product.gziRelPath),
  };
}

async function productsMatchOriginalFai(
  products: ReturnType<typeof bgzfFastaProductPaths>
): Promise<boolean> {
  if (!(await regularNonEmptyFile(products.fastaPath))) return false;
  if (!(await regularNonEmptyFile(products.faiPath))) return false;
  if (!(await regularNonEmptyFile(products.gziPath))) return false;
  const [original, copied] = await Promise.all([
    readFile(products.uncompressedFaiPath),
    readFile(products.faiPath),
  ]);
  return original.equals(copied);
}

async function writeReceipt(path: string, receipt: BgzfFastaMigrationReceiptV1): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  const handle = await open(temporaryPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function unlinkOriginal(path: string): Promise<void> {
  const receiptPath = `${path}.verified.v1.json`;
  await Promise.all([clearReadonlyIfPresent(path), clearReadonlyIfPresent(receiptPath)]);
  await Promise.all([rm(path, { force: true }), rm(receiptPath, { force: true })]);
}

async function clearReadonlyIfPresent(path: string): Promise<void> {
  try {
    await chmod(path, 0o666);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function fileIdentity(path: string): Promise<{ sha256: string; byteLength: number }> {
  const metadata = await stat(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), byteLength: metadata.size };
}

async function regularNonEmptyFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size > 0;
  } catch {
    return false;
  }
}

async function resolveCompressFastaBinary(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    configuredIndexerBinary,
    process.env.DNA_INDEXER_PATH,
    ...(process.env.DNAFORGE_HELPERS_DIR
      ? [join(process.env.DNAFORGE_HELPERS_DIR, dnaIndexerHelperName())]
      : []),
    resolve(process.cwd(), 'target/debug', dnaIndexerUnsuffixedName()),
    resolve(process.cwd(), 'target/release', dnaIndexerUnsuffixedName()),
  ].filter((value): value is string => Boolean(value && value.trim()));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return resolve(candidate);
    } catch {}
  }
  throw new Error(
    `dna-indexer executable not found for compress-fasta. Searched: ${candidates.join(', ')}`
  );
}

export function dnaIndexerBinaryFileName(): string {
  return process.platform === 'win32' ? 'dna-indexer.exe' : 'dna-indexer';
}

export function resolveBuiltDnaIndexerBinary(repoRoot: string): string | null {
  const name = dnaIndexerBinaryFileName();
  for (const profile of ['debug', 'release'] as const) {
    const candidate = join(repoRoot, 'target', profile, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function dnaIndexerUnsuffixedName(): string {
  return dnaIndexerBinaryFileName();
}

function dnaIndexerHelperName(): string {
  const suffix =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : process.platform === 'darwin' && process.arch === 'x64'
        ? 'x86_64-apple-darwin'
        : process.platform === 'linux' && process.arch === 'arm64'
          ? 'aarch64-unknown-linux-musl'
          : process.platform === 'linux' && process.arch === 'x64'
            ? 'x86_64-unknown-linux-musl'
            : process.platform === 'win32' && process.arch === 'x64'
              ? 'x86_64-pc-windows-msvc'
              : null;
  if (!suffix) {
    throw new Error(`dna-indexer is unsupported on ${process.platform}/${process.arch}.`);
  }
  return `dna-indexer-${suffix}${process.platform === 'win32' ? '.exe' : ''}`;
}

function normalizeInstallPath(installPath: string): string {
  return installPath.replace(/\\/g, '/');
}

function isBasename(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  );
}

function requireBasename(value: unknown): string | null {
  return typeof value === 'string' && isBasename(value) ? value : null;
}

function requireSha256(value: unknown): string | null {
  return typeof value === 'string' && SHA256.test(value) ? value : null;
}

function requirePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function assertAtOrBelow(root: string, candidate: string, label: string): void {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new Error(`${label} must be absolute.`);
  }
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} is outside its generation root: ${candidate}`);
  }
}
