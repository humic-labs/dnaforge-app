import type Database from 'better-sqlite3';
import { readdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import {
  typedDocumentKindForPath,
  isLiteralDocumentKind,
  type DocumentAvailabilityProbe,
  type DocumentAvailabilityRequest,
} from '../shared/document-availability';
import { detectDocumentPackage } from '../shared/document-package';
import { blockedDocument, DocumentReadError } from '../shared/document-read-failure';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { isForgePackageMetaPath } from '../shared/forge-package-path';
import { createDocumentOpenSource, documentOpenPath } from './document-open-source';
import { developerImportSourceRootsInDb } from './registry-source-eligibility';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { readRegisteredMolecularDocument } from './registered-molecular-document';
import { molecularDocumentReadFailure } from '../shared/molecular-document-read-failure';
import type { ReadySequencePackage } from './portable-document-open-check';

export async function checkWorkspaceDocument(
  db: Database.Database,
  request: DocumentAvailabilityRequest
): Promise<DocumentAvailabilityProbe> {
  let kind =
    typedDocumentKindForPath(request.path) ??
    (isLiteralDocumentKind(request.literalKind) ? request.literalKind : undefined);
  if (!kind && !request.package) return { state: 'unchecked' };
  let source: ReturnType<typeof createDocumentOpenSource> | undefined;
  try {
    const authority = createRegisteredProjectAuthority({ db: () => db });
    const project = request.workspaceRoot ? authority.resolve(request.workspaceRoot) : undefined;
    const canonicalRoot = request.workspaceRoot
      ? await documentOpenPath(request.workspaceRoot)
      : undefined;
    if (
      canonicalRoot &&
      !project &&
      !isDeveloperImportSourcePath(canonicalRoot, developerImportSourceRootsInDb(db))
    )
      throw new DocumentReadError('project');
    const assertProjectCurrent = project ? authority.capture(project.projectId) : undefined;
    const fileParent = dirname(request.path);
    const workspaceRoot =
      request.workspaceRoot ??
      (isForgePackageMetaPath(request.path, request.path.split(/[\\/]/u).at(-1) ?? '')
        ? dirname(fileParent)
        : fileParent);
    source = createDocumentOpenSource(db, workspaceRoot, request.path, canonicalRoot);
    const origin = await source.observeFile(request.path);
    let path = request.path;
    if (!origin.stat) throw new DocumentReadError('missing');
    if (origin.stat.isDirectory()) {
      const directory = source;
      const detected = await detectDocumentPackage(request.path, {
        exists: async (candidate) => Boolean((await directory.observeFile(candidate)).stat),
        readDir: async (candidate) =>
          (
            await readdir((await directory.observeFile(candidate)).canonical, {
              withFileTypes: true,
            })
          ).map((entry) => ({
            name: entry.name,
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
          })),
      });
      if (!detected) throw new DocumentReadError('unsupported-format');
      path = detected.metadataPath;
      kind = typedDocumentKindForPath(path);
    } else if (!origin.stat.isFile()) {
      throw new DocumentReadError('unsupported-format');
    }
    if (!kind) throw new DocumentReadError('unsupported-format');

    const readerSource = source.forPath(path);
    let fileRevision: string | undefined;
    let sequencePackage: ReadySequencePackage | void = undefined;
    switch (kind) {
      case 'image':
      case 'pdf':
      case 'table':
      case 'html': {
        const slicedTable = kind === 'table' && /^\.(csv|tsv)$/iu.test(extname(path));
        if (!slicedTable && origin.stat.size > HARD_CAP_BYTES)
          throw new DocumentReadError('too-large');
        await source.checkReadable(path);
        const revision = await source.verifyCurrent();
        assertProjectCurrent?.();
        return { state: 'inspect', kind, path, revision, paths: source.paths() };
      }
      case 'molecular-document': {
        if (!request.workspaceRoot || !project) throw new DocumentReadError('project');
        try {
          fileRevision = (await readRegisteredMolecularDocument(db, { workspaceRoot, path }))
            .revision;
        } catch (error) {
          throw molecularDocumentReadFailure(error);
        }
        break;
      }
      case 'structure':
      case 'sequence':
      case 'protein': {
        const { inspectLooseScientificDocument } = await import('./loose-scientific-open-check');
        await inspectLooseScientificDocument(kind, readerSource);
        break;
      }
      default: {
        const { inspectPortableDocument } = await import('./portable-document-open-check');
        const portable = await inspectPortableDocument(kind, readerSource);
        if (portable && 'kind' in portable) {
          const revision = await source.verifyCurrent();
          assertProjectCurrent?.();
          return {
            state: 'inspect-design-draft',
            designId: portable.designId,
            revision,
            paths: source.paths(),
          };
        }
        sequencePackage = portable;
      }
    }
    const revision = await source.verifyCurrent();
    assertProjectCurrent?.();
    return {
      state: 'ready',
      kind,
      revision: fileRevision ?? revision,
      paths: source.paths(),
      ...(sequencePackage ? { sequencePackage } : {}),
    };
  } catch (error) {
    // A file that disappeared or changed while a reader was working does not
    // prove that the document itself is broken.
    try {
      await source?.verifyCurrent();
    } catch (verificationError) {
      if (verificationError instanceof DocumentReadError && verificationError.code === 'changed')
        return blockedDocument(verificationError, source?.paths());
    }
    if (
      error instanceof Error &&
      (error.message.startsWith('PROJECT_ACCESS_DENIED:') ||
        error.message.startsWith('PROJECT_ACCESS_CHANGED:'))
    )
      return blockedDocument(new DocumentReadError('project'), source?.paths());
    return blockedDocument(error, source?.paths());
  }
}
