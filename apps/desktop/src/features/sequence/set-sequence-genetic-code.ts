import {
  isCodingFeature,
  parseTranslTableQualifier,
  isCustomGeneticCodeSpec,
  resolveSequenceGeneticCode,
  updateGenBankGeneticCodeComment,
  validateCustomGeneticCode,
  type GeneticCodeSpec,
  type SequenceGeneticCodeResolution,
} from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { parseSequenceFileAsDocument } from './parse-sequence-file';
import { managedSequenceRepository } from './managed-sequence-repository';
import { gitCommitPaths, gitRepoRoot } from '../workspace/public/git';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import { resolveSequenceDocumentById } from './sequence-document-repository';
import { geneticCodeChangeSubject } from './genetic-code-change-subject';
import { useSequenceStore } from './store';

export type SetSequenceGeneticCodeFailure =
  | 'document_not_found'
  | 'outside_workspace'
  | 'document_unavailable'
  | 'unsaved_edits'
  | 'invalid_genetic_code'
  | 'write_failed';

export interface SetSequenceGeneticCodeInput {
  readonly documentId: string;
  readonly geneticCode: GeneticCodeSpec | null;
  readonly folders: readonly WorkspaceFolder[];
}

export type SetSequenceGeneticCodeOutcome =
  | {
      readonly ok: true;
      readonly resolved: SequenceGeneticCodeResolution;
      readonly featuresDeclaringTheirOwnCode: readonly string[];
      readonly savedToFile: boolean;
    }
  | {
      readonly ok: false;
      readonly error: SetSequenceGeneticCodeFailure;
      readonly message: string;
    };

function failure(
  error: SetSequenceGeneticCodeFailure,
  message: string
): SetSequenceGeneticCodeOutcome {
  return { ok: false, error, message };
}

export async function setSequenceGeneticCodeOnDocument({
  documentId,
  geneticCode,
  folders,
}: SetSequenceGeneticCodeInput): Promise<SetSequenceGeneticCodeOutcome> {
  if (isCustomGeneticCodeSpec(geneticCode)) {
    const issues = validateCustomGeneticCode(geneticCode);
    if (issues.length > 0) {
      return failure(
        'invalid_genetic_code',
        `That custom genetic code is not valid: ${issues[0].message}`
      );
    }
  }

  let sourcePath: string;
  try {
    sourcePath = (
      await resolveSequenceDocumentById(
        documentId,
        folders.map((folder) => folder.path)
      )
    ).sourcePath;
  } catch {
    return failure('document_not_found', `No sequence document matches "${documentId}".`);
  }

  if (!findContainingPathBoundary([...folders], sourcePath)) {
    return failure(
      'outside_workspace',
      'That sequence document is outside the writable mounted workspace.'
    );
  }

  if (!useSequenceStore.getState().getSequence(documentId)) {
    try {
      const content = await platform().fs.readAdmittedTextFile({
        path: sourcePath,
        projectRoots: folders.map((folder) => folder.path),
        grantedFiles: [],
      });
      const parsed = parseSequenceFileAsDocument(content, sourcePath);
      if (!useSequenceStore.getState().getSequence(documentId)) {
        useSequenceStore.getState().setSequence(documentId, parsed.sequence);
      }
    } catch {
      return failure('document_unavailable', 'That sequence document could not be loaded.');
    }
  }

  const store = useSequenceStore.getState();
  if (store.isDirty(documentId)) {
    return failure(
      'unsaved_edits',
      'That sequence document has unsaved edits. Save or discard them first, so setting ' +
        'the genetic code does not also commit changes you did not ask about.'
    );
  }

  try {
    if (!(await writeGeneticCodeIntoFile(sourcePath, geneticCode, folders))) {
      return failure(
        'write_failed',
        'The genetic code could not be written: the file has no GenBank LOCUS line.'
      );
    }
  } catch (error) {
    return failure(
      'write_failed',
      error instanceof Error && error.message
        ? error.message
        : 'The genetic code could not be written to the file.'
    );
  }

  useSequenceStore.getState().patchSavedMetadata(documentId, {
    chosenGeneticCode: geneticCode ?? undefined,
  });

  notifyFileChanged(sourcePath);

  const saved = useSequenceStore.getState().getSequence(documentId);
  const resolved = resolveSequenceGeneticCode(saved ?? { annotations: [] });
  const featuresDeclaringTheirOwnCode = (saved?.annotations ?? [])
    .filter(
      (annotation) => isCodingFeature(annotation) && parseTranslTableQualifier(annotation) !== null
    )
    .map((annotation) => annotation.name);

  return {
    ok: true,
    resolved,
    featuresDeclaringTheirOwnCode,
    savedToFile: true,
  };
}

async function writeGeneticCodeIntoFile(
  sourcePath: string,
  geneticCode: GeneticCodeSpec | null,
  folders: readonly WorkspaceFolder[]
): Promise<boolean> {
  const managed = await managedSequenceRepository.findByMemberPath(sourcePath).catch(() => null);
  if (managed) {
    await managedSequenceRepository.updateMetadata(managed.ref, (current) => current, {
      geneticCode,
    });
    return true;
  }

  const content = await platform().fs.readAdmittedTextFile({
    path: sourcePath,
    projectRoots: folders.map((folder) => folder.path),
    grantedFiles: [],
  });
  if (!/^LOCUS\b/m.test(content)) return false;
  await platform().fs.writeTextFileAtomic({
    path: sourcePath,
    content: updateGenBankGeneticCodeComment(content, geneticCode),
  });
  await commitLooseFileChange(sourcePath, geneticCode);
  return true;
}

async function commitLooseFileChange(
  sourcePath: string,
  geneticCode: GeneticCodeSpec | null
): Promise<void> {
  try {
    const repoRoot = await gitRepoRoot(sourcePath);
    if (!repoRoot) return;
    const relativePath = pathRelativeToBoundary(sourcePath, repoRoot);
    if (!relativePath) return;
    await gitCommitPaths(
      repoRoot,
      `Update ${geneticCodeChangeSubject(geneticCode)} for ${relativePath}`,
      [relativePath]
    );
  } catch (error) {
    console.warn('[GeneticCode] Change written but not committed separately:', error);
  }
}

function notifyFileChanged(sourcePath: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('waypoint:workspace-reconciled', { detail: { path: sourcePath } })
  );
  window.dispatchEvent(
    new CustomEvent('waypoint:workspace-files-changed', { detail: { path: sourcePath } })
  );
}
