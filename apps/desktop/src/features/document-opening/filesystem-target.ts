import { inferCatalogFileKind } from '../../shared/catalog-file-kind';
import type { FilesystemStat } from '../../shared/filesystem-stat';
import { MAX_FULL_TEXT_FILE_SIZE } from '../../shared/text-file-limits';
import { detectDocumentPackage, type DocumentPackageIo } from '../../shared/document-package';
import type { DocumentTarget } from './types';

interface FilesystemDocumentIo extends DocumentPackageIo {
  stat(path: string): Promise<Pick<FilesystemStat, 'isFile' | 'isDirectory' | 'size'>>;
}
type TargetResolution =
  | { status: 'resolved'; target: DocumentTarget }
  | { status: 'unsupported'; message: string }
  | { status: 'cancelled' };

export function resolveFilesystemDocumentTarget(
  target: Extract<DocumentTarget, { kind: 'file' }>,
  io: FilesystemDocumentIo,
  signal?: AbortSignal,
  previewLargeReadFile = false
): Promise<TargetResolution> {
  if (signal?.aborted) return Promise.resolve({ status: 'cancelled' });
  const inspection = inspectFilesystemDocumentTarget(target, io, previewLargeReadFile);
  if (!signal) return inspection;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      resolve({ status: 'cancelled' });
    };
    signal.addEventListener('abort', cancel, { once: true });
    inspection.then(
      (result) => {
        signal.removeEventListener('abort', cancel);
        resolve(result);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(cause);
      }
    );
    if (signal.aborted) cancel();
  });
}

async function inspectFilesystemDocumentTarget(
  target: Extract<DocumentTarget, { kind: 'file' }>,
  io: FilesystemDocumentIo,
  previewLargeReadFile: boolean
): Promise<TargetResolution> {
  const source = await io.stat(target.path);
  if (source.isFile) {
    if (
      previewLargeReadFile &&
      source.size > MAX_FULL_TEXT_FILE_SIZE &&
      (target.tabType === undefined || target.tabType === 'sequence') &&
      inferCatalogFileKind(target.path) === 'fastq'
    ) {
      return { status: 'resolved', target: { ...target, tabType: 'text' } };
    }
    return { status: 'resolved', target };
  }
  if (source.isDirectory) {
    const container = await detectDocumentPackage(target.path, io);
    if (container?.kind === 'sequence')
      return { status: 'resolved', target: { kind: 'sequence-package', path: target.path } };
    if (container?.kind === 'notebook')
      return { status: 'resolved', target: { kind: 'file', path: target.path, tabType: 'page' } };
    if (container)
      return { status: 'resolved', target: { kind: 'file', path: container.metadataPath } };
    return { status: 'unsupported', message: 'This folder is not an openable document package.' };
  }
  return { status: 'unsupported', message: 'This path is not a regular file or document package.' };
}
