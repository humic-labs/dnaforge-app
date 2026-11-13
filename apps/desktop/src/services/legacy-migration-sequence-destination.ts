import {
  SEQUENCE_PACKAGE_META_NAME,
  parseSequencePackageDocument,
  sequenceProductExtensionForPath,
} from '../db/sequence-package';

const MAX_PLASMID_PACKAGE_MARKER_BYTES = 256 * 1024;

type MigrationDestinationFileSystem = {
  exists(path: string): Promise<boolean>;
  readFileBounded(path: string, maxBytes: number): Promise<Uint8Array>;
  stat(path: string): Promise<{ isFile: boolean } | null>;
  validateWorkspacePath(input: {
    workspaceRoot: string;
    path: string;
    artifactNoun?: string;
  }): Promise<boolean>;
};

type LegacyPackageCandidate = {
  markerPath: string;
  productFileName: string;
  productPath: string;
};

export async function resolveMigrationSequenceDestinationPath(input: {
  fs: MigrationDestinationFileSystem;
  indexedPath: string;
  workspaceRoot: string;
}): Promise<string> {
  if (await input.fs.exists(input.indexedPath)) {
    await assertRegularContainedFile(input.fs, input.workspaceRoot, input.indexedPath);
    return input.indexedPath;
  }

  const candidate = legacyPackageCandidate(input.indexedPath);
  if (!candidate) {
    throw new Error('the preserved sequence destination is unavailable');
  }
  if (
    !(await input.fs.exists(candidate.productPath)) ||
    !(await input.fs.exists(candidate.markerPath))
  ) {
    throw new Error('the preserved sequence destination is unavailable');
  }
  await Promise.all([
    assertRegularContainedFile(input.fs, input.workspaceRoot, candidate.productPath),
    assertRegularContainedFile(input.fs, input.workspaceRoot, candidate.markerPath),
  ]);

  const markerBytes = await input.fs.readFileBounded(
    candidate.markerPath,
    MAX_PLASMID_PACKAGE_MARKER_BYTES
  );
  if (markerBytes.byteLength <= 0 || markerBytes.byteLength > MAX_PLASMID_PACKAGE_MARKER_BYTES) {
    throw new Error('the migrated plasmid package marker is invalid');
  }
  let markerText: string;
  try {
    markerText = new TextDecoder('utf-8', { fatal: true }).decode(markerBytes);
  } catch {
    throw new Error('the migrated plasmid package marker is invalid');
  }
  const document = parseSequencePackageDocument(markerText);
  if (document.product.file !== candidate.productFileName) {
    throw new Error('the migrated plasmid package marker names a different product');
  }
  await assertRegularContainedFile(input.fs, input.workspaceRoot, candidate.productPath);
  return candidate.productPath;
}

async function assertRegularContainedFile(
  fs: MigrationDestinationFileSystem,
  workspaceRoot: string,
  path: string
): Promise<void> {
  const [contained, stats] = await Promise.all([
    fs.validateWorkspacePath({
      workspaceRoot,
      path,
      artifactNoun: 'migration destination',
    }),
    fs.stat(path),
  ]);
  if (!contained || !stats?.isFile) {
    throw new Error('the preserved sequence destination is outside its project');
  }
}

function legacyPackageCandidate(indexedPath: string): LegacyPackageCandidate | null {
  const separatorIndex = Math.max(indexedPath.lastIndexOf('/'), indexedPath.lastIndexOf('\\'));
  if (separatorIndex <= 0 || separatorIndex === indexedPath.length - 1) return null;
  const separator = indexedPath[separatorIndex];
  const parent = indexedPath.slice(0, separatorIndex);
  const productFileName = indexedPath.slice(separatorIndex + 1);
  const extension = sequenceProductExtensionForPath(productFileName);
  if (!extension) return null;
  const stem = productFileName.slice(0, -extension.length);
  if (!stem || stem === '.' || stem === '..' || stem.includes('/') || stem.includes('\\')) {
    return null;
  }
  const packageRoot = `${parent}${separator}${stem}`;
  return {
    markerPath: `${packageRoot}${separator}.forge${separator}${SEQUENCE_PACKAGE_META_NAME}`,
    productFileName,
    productPath: `${packageRoot}${separator}${productFileName}`,
  };
}
