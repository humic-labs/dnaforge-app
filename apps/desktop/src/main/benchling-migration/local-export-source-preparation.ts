import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { Zip, ZipPassThrough } from 'fflate';

import { DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS } from './native-export-archive';

const ZIP_FILENAME_BYTES_LIMIT = 65_535;
const DETERMINISTIC_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);

export type PreparedLocalBenchlingExportSource = Readonly<{
  archivePath: string;
  sourceDisplayName: string;
  managed: boolean;
}>;

type ExportFile = Readonly<{
  absolutePath: string;
  archivePath: string;
  size: number;
  device: number;
  inode: number;
  modifiedAtMs: number;
  changedAtMs: number;
}>;

export async function prepareLocalBenchlingExportSource(input: {
  sourcePath: string;
  stagingRootDir: string;
}): Promise<PreparedLocalBenchlingExportSource> {
  const sourcePath = resolve(input.sourcePath);
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error('Choose the Benchling ZIP export or its real unzipped folder, not an alias.');
  }
  if (sourceStat.isFile()) {
    if (!/\.zip$/iu.test(sourcePath)) {
      throw new Error('Choose a Benchling ZIP export or an unzipped Benchling export folder.');
    }
    return { archivePath: sourcePath, sourceDisplayName: basename(sourcePath), managed: false };
  }
  if (!sourceStat.isDirectory()) {
    throw new Error('Choose a Benchling ZIP export or an unzipped Benchling export folder.');
  }

  const files = await listExportFiles(sourcePath);
  if (files.length === 0) {
    throw new Error('The selected folder is empty. Choose an unzipped Benchling export folder.');
  }

  await mkdir(input.stagingRootDir, { recursive: true, mode: 0o700 });
  const archivePath = join(input.stagingRootDir, `${randomUUID()}.zip`);
  try {
    await writeStoreOnlyZip(files, archivePath);
  } catch (error) {
    await unlink(archivePath).catch(() => undefined);
    throw error;
  }
  return { archivePath, sourceDisplayName: basename(sourcePath), managed: true };
}

async function listExportFiles(rootPath: string): Promise<ExportFile[]> {
  const files: ExportFile[] = [];
  let totalBytes = 0;
  const pending = [rootPath];

  while (pending.length > 0) {
    const directoryPath = pending.pop();
    if (!directoryPath) break;
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`The selected folder contains an alias: ${entry.name}`);
      }
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`The selected folder contains an unsupported item: ${entry.name}`);
      }

      const archivePath = toSafeArchivePath(rootPath, absolutePath);
      const fileStat = await lstat(absolutePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`The selected folder changed while DNAForge was reading ${archivePath}.`);
      }
      if (fileStat.size > DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxEntryUncompressedBytes) {
        throw new Error(`The selected folder contains a file that is too large: ${archivePath}`);
      }
      totalBytes += fileStat.size;
      if (totalBytes > DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
        throw new Error('The selected folder is too large to import safely.');
      }
      files.push({
        absolutePath,
        archivePath,
        size: fileStat.size,
        device: fileStat.dev,
        inode: fileStat.ino,
        modifiedAtMs: fileStat.mtimeMs,
        changedAtMs: fileStat.ctimeMs,
      });
      if (files.length > DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxEntries) {
        throw new Error('The selected folder contains too many files to import safely.');
      }
    }
  }

  return files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

function toSafeArchivePath(rootPath: string, absolutePath: string): string {
  const localPath = relative(rootPath, absolutePath);
  if (!localPath || localPath === '..' || localPath.startsWith(`..${sep}`)) {
    throw new Error('The selected folder contains a file outside the export folder.');
  }
  const archivePath = localPath.split(sep).join('/').normalize('NFC');
  if (
    archivePath.startsWith('/') ||
    archivePath.includes('\\') ||
    hasControlCharacters(archivePath) ||
    Buffer.byteLength(archivePath, 'utf8') > ZIP_FILENAME_BYTES_LIMIT
  ) {
    throw new Error(`The selected folder contains an unsupported path: ${localPath}`);
  }
  return archivePath;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

async function writeStoreOnlyZip(files: readonly ExportFile[], archivePath: string): Promise<void> {
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
  let outputError: Error | null = null;
  let drain: Promise<unknown> = Promise.resolve();
  const finished = new Promise<void>((resolveFinished, rejectFinished) => {
    output.once('finish', resolveFinished);
    output.once('error', rejectFinished);
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      outputError = error;
      output.destroy(error);
      return;
    }
    if (chunk.length > 0 && !output.write(chunk)) drain = once(output, 'drain');
    if (final) output.end();
  });

  try {
    for (const file of files) {
      if (outputError) throw outputError;
      const entry = new ZipPassThrough(file.archivePath);
      entry.mtime = DETERMINISTIC_ZIP_MTIME;
      entry.os = 3;
      entry.attrs = 0o100600 << 16;
      zip.add(entry);
      const input = createReadStream(file.absolutePath);
      let bytesRead = 0;
      for await (const chunk of input) {
        const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
        bytesRead += bytes.length;
        entry.push(bytes, false);
        await drain;
      }
      if (bytesRead !== file.size) {
        throw new Error(
          `The selected folder changed while DNAForge was reading ${file.archivePath}.`
        );
      }
      const afterRead = await lstat(file.absolutePath);
      if (
        !afterRead.isFile() ||
        afterRead.isSymbolicLink() ||
        afterRead.size !== file.size ||
        afterRead.dev !== file.device ||
        afterRead.ino !== file.inode ||
        afterRead.mtimeMs !== file.modifiedAtMs ||
        afterRead.ctimeMs !== file.changedAtMs
      ) {
        throw new Error(
          `The selected folder changed while DNAForge was reading ${file.archivePath}.`
        );
      }
      entry.push(new Uint8Array(0), true);
      await drain;
    }
    zip.end();
    await finished;
    if (outputError) throw outputError;
  } catch (error) {
    zip.terminate();
    output.destroy();
    throw error;
  }
}
