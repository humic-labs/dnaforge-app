import type { FilesystemStat } from '../../shared/filesystem-stat';
import { detectDocumentPackage, type DocumentPackageIo } from '../../shared/document-package';
import type { DocumentTarget } from './types';
import { typedDocumentKindForPath } from '../../shared/document-availability';

interface FilesystemDocumentIo extends DocumentPackageIo {
  stat(path: string): Promise<Pick<FilesystemStat, 'isFile' | 'isDirectory'>>;
}
type TargetResolution =
  | { status: 'resolved'; target: DocumentTarget; packageRoot?: string }
  | { status: 'unsupported'; message: string }
  | { status: 'cancelled' };

export function resolveFilesystemDocumentTarget(
  target: Extract<DocumentTarget, { kind: 'file' }>,
  io: FilesystemDocumentIo,
  signal?: AbortSignal
): Promise<TargetResolution> {
  if (signal?.aborted) return Promise.resolve({ status: 'cancelled' });
  const inspection = inspectFilesystemDocumentTarget(target, io);
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
  io: FilesystemDocumentIo
): Promise<TargetResolution> {
  const source = await io.stat(target.path);
  if (source.isFile) {
    if (typedDocumentKindForPath(target.path) === 'sequence-package') {
      const packageRoot = target.path.replace(/[\\/]\.forge[\\/][^\\/]+$/iu, '');
      return {
        status: 'resolved',
        target: { kind: 'sequence-package', path: packageRoot },
        packageRoot,
      };
    }
    return { status: 'resolved', target };
  }
  if (source.isDirectory) {
    const container = await detectDocumentPackage(target.path, io);
    if (container?.kind === 'sequence')
      return {
        status: 'resolved',
        target: { kind: 'sequence-package', path: target.path },
        packageRoot: target.path,
      };
    if (container?.kind === 'notebook')
      return {
        status: 'resolved',
        target: { kind: 'file', path: target.path, tabType: 'page' },
        packageRoot: target.path,
      };
    if (container)
      return {
        status: 'resolved',
        target: { kind: 'file', path: container.metadataPath },
        packageRoot: target.path,
      };
    return { status: 'unsupported', message: 'This folder is not an openable document package.' };
  }
  return { status: 'unsupported', message: 'This path is not a regular file or document package.' };
}
