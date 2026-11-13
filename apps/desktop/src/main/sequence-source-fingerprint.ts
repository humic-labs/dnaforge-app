import { readdir } from 'node:fs/promises';
import { isTextSequenceFileKind } from '../shared/catalog-file-kind';
import {
  fingerprintSequenceBytes,
  MAX_FINGERPRINT_SOURCE_BYTES,
} from '../shared/sequence-bytes-fingerprint';
import {
  parseSequencePackageDocument,
  resolveSequenceProductFile,
  sequencePackagePaths,
} from '../db/sequence-package';
import { isSequencePackageFileKind } from '../db/sequence-package-contract';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';

const MAX_PACKAGE_METADATA_BYTES = 4 * 1024 * 1024;
const TRACE_FILE_KIND = 'trace';

export function isFingerprintableFileKind(fileKind: string): boolean {
  return (
    isTextSequenceFileKind(fileKind) ||
    fileKind === TRACE_FILE_KIND ||
    isSequencePackageFileKind(fileKind)
  );
}

async function packageProductPath(packageRoot: string): Promise<string> {
  const metadata = await readFileBoundedFromHandle(
    sequencePackagePaths(packageRoot).metaPath,
    MAX_PACKAGE_METADATA_BYTES
  );
  const document = parseSequencePackageDocument(new TextDecoder().decode(metadata));
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const productFile = resolveSequenceProductFile(
    document.product.file,
    entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() }))
  );
  return sequencePackagePaths(packageRoot, { productFile }).productPath;
}

export async function fingerprintSequenceSource(
  path: string,
  fileKind: string
): Promise<string | null> {
  if (!isFingerprintableFileKind(fileKind)) return null;
  try {
    const sourcePath = isSequencePackageFileKind(fileKind) ? await packageProductPath(path) : path;
    return await fingerprintSequenceBytes(
      await readFileBoundedFromHandle(sourcePath, MAX_FINGERPRINT_SOURCE_BYTES),
      sourcePath
    );
  } catch {
    return null;
  }
}
