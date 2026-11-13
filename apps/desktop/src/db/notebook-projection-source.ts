import {
  isNotebookPackageMetaPath,
  parseNotebookPackageDocument,
  NOTEBOOK_PACKAGE_SCHEMA,
  type NotebookPackageDocument,
} from './notebook-package';
import {
  readCanonicalNotebookPackage,
  type NotebookPackageFileOps,
  type ReadNotebookPackageV2Result,
} from './notebook-package-migration';
import { contentFingerprint } from '../shared/content-fingerprint';

export function notebookDocumentFromCanonicalSource({
  metadata,
  parsed,
}: Pick<ReadNotebookPackageV2Result, 'metadata' | 'parsed'>): NotebookPackageDocument {
  return {
    ...metadata,
    schema: NOTEBOOK_PACKAGE_SCHEMA,
    kind: 'notebook',
    id: parsed.id,
    title: parsed.title,
    content: parsed.content,
    updatedAt: metadata.updatedAt,
    storage: { type: 'database', table: 'pages', id: parsed.id },
  };
}

export async function readNotebookProjectionSource(
  ops: Pick<NotebookPackageFileOps, 'exists' | 'readTextFile'>,
  sourcePath: string
): Promise<{ document: NotebookPackageDocument; authorityFingerprint: string }> {
  const metadataRaw = await ops.readTextFile(sourcePath);
  const candidate: unknown = JSON.parse(metadataRaw);
  if (
    isNotebookPackageMetaPath(sourcePath) &&
    candidate &&
    typeof candidate === 'object' &&
    'formatVersion' in candidate
  ) {
    const packageRoot = sourcePath.replace(/[/\\]\.forge[/\\]notebook\.json$/iu, '');
    const source = await readCanonicalNotebookPackage(ops, packageRoot, metadataRaw);
    return {
      document: notebookDocumentFromCanonicalSource(source),
      authorityFingerprint: contentFingerprint(source.markdown),
    };
  }
  return {
    document: parseNotebookPackageDocument(metadataRaw),
    authorityFingerprint: contentFingerprint(metadataRaw),
  };
}
