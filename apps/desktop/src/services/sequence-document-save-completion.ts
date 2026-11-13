import type {
  SequenceDocumentSavePublication,
  SequenceDocumentWriteReceipt,
  SequenceDocumentHistoryResult,
} from '../shared/sequence-edit-lineage';
import { emitLimsRegistrationChanged } from '../features/lims/public/events';
import { gitCommitFile, gitCommitPaths, gitRepoRoot } from '../features/workspace/public/git';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
} from '../db/sequence-package';
import { platform } from '../platform';
import { pathRelativeToBoundary } from '../shared/path-boundary';

export interface SavedSequenceDocument {
  documentId: string;
  sourcePath: string;
}

export type SequenceDocumentSaveCompletion = (
  | { status: 'committed'; repositoryRoot: string }
  | { status: 'not-a-repository' }
  | {
      status: 'commit-failed';
      error: unknown;
      historyStatus?: 'revision-changed' | 'unavailable' | 'failed';
    }
) & { nativeActionId?: string; delivery?: 'pending' };

export interface SequenceDocumentSaveProjectionFailure {
  stage: 'workspace' | 'staleness' | 'lims';
  error: unknown;
}

export class SequenceDocumentSaveProjectionError extends Error {
  readonly completion: SequenceDocumentSaveCompletion;
  readonly failures: readonly [
    SequenceDocumentSaveProjectionFailure,
    ...SequenceDocumentSaveProjectionFailure[],
  ];
  readonly cause: unknown;

  constructor(
    completion: SequenceDocumentSaveCompletion,
    failures: [SequenceDocumentSaveProjectionFailure, ...SequenceDocumentSaveProjectionFailure[]]
  ) {
    super('The saved sequence could not finish its post-save projection.');
    this.name = 'SequenceDocumentSaveProjectionError';
    this.completion = completion;
    this.failures = failures;
    this.cause = failures[0].error;
  }
}

export async function completeSavedSequenceDocument(
  document: SavedSequenceDocument,
  message: string,
  checkStaleness: (documentId: string) => Promise<void>,
  publication?: SequenceDocumentSavePublication | SequenceDocumentWriteReceipt
): Promise<SequenceDocumentSaveCompletion> {
  const receipt =
    publication && 'nativeActionId' in publication ? publication : publication?.history?.receipt;
  const ownedPublication = publication && 'kind' in publication ? publication : undefined;
  const repositoryRoot = ownedPublication
    ? ownedPublication.repositoryRoot
    : await gitRepoRoot(document.sourcePath);
  const nativeCompletion = (
    result: SequenceDocumentHistoryResult
  ): SequenceDocumentSaveCompletion =>
    result.status === 'not-a-repository'
      ? { status: 'not-a-repository', nativeActionId: result.nativeActionId }
      : (result.status === 'committed' || result.status === 'already-committed') && repositoryRoot
        ? { status: 'committed', repositoryRoot, nativeActionId: result.nativeActionId }
        : {
            status: 'commit-failed',
            historyStatus:
              result.status === 'revision-changed' || result.status === 'unavailable'
                ? result.status
                : 'failed',
            error: new Error('Sequence saved; native history checkpoint needs attention.'),
            nativeActionId: result.nativeActionId,
          };
  let completion: SequenceDocumentSaveCompletion;
  if (ownedPublication?.history) {
    completion = nativeCompletion(ownedPublication.history.result);
  } else if (!repositoryRoot) {
    completion = { status: 'not-a-repository' };
  } else if (ownedPublication) {
    completion = { status: 'committed', repositoryRoot };
  } else {
    try {
      if (receipt)
        completion = nativeCompletion(
          await platform().fs.commitSequenceDocumentHistory({ ...document, ...receipt, message })
        );
      else {
        const packagePaths = await packageRevisionPathsForSavedFile(document.sourcePath);
        if (packagePaths) {
          const relativePaths = packagePaths.map((path) => {
            const relative = pathRelativeToBoundary(path, repositoryRoot);
            if (!relative)
              throw new Error('Sequence package revision files are outside the Git repository.');
            return relative;
          });
          await gitCommitPaths(repositoryRoot, message, relativePaths);
        } else await gitCommitFile(document.sourcePath, message, repositoryRoot);
        completion = { status: 'committed', repositoryRoot };
      }
    } catch (error: unknown) {
      completion = { status: 'commit-failed', error };
    }
  }

  const failures: SequenceDocumentSaveProjectionFailure[] = [];
  if (receipt && completion.status === 'committed') {
    try {
      await refreshSavedSequenceSession(document);
    } catch (error) {
      failures.push({ stage: 'workspace', error });
    }
  }
  try {
    window.dispatchEvent(
      new CustomEvent('waypoint:workspace-files-changed', {
        detail: { path: document.sourcePath },
      })
    );
  } catch (error) {
    failures.push({ stage: 'workspace', error });
  }
  let stalenessCheck: Promise<void> | undefined;
  try {
    stalenessCheck = checkStaleness(document.documentId).then(
      () => undefined,
      (error: unknown) => {
        failures.push({ stage: 'staleness', error });
      }
    );
  } catch (error) {
    failures.push({ stage: 'staleness', error });
  }
  try {
    emitLimsRegistrationChanged({
      documentId: document.documentId,
      filePath: document.sourcePath,
    });
  } catch (error) {
    failures.push({ stage: 'lims', error });
  }
  await stalenessCheck;
  const [firstFailure, ...otherFailures] = failures;
  if (firstFailure)
    throw new SequenceDocumentSaveProjectionError(completion, [firstFailure, ...otherFailures]);

  return completion;
}

async function packageRevisionPathsForSavedFile(sourcePath: string): Promise<string[] | null> {
  const slash = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  if (slash < 1) return null;
  const packageRoot = sourcePath.slice(0, slash);
  const markerPath = sequencePackagePaths(packageRoot).metaPath;
  const fs = platform().fs;
  if (!(await fs.exists(markerPath))) return null;
  const document = parseSequencePackageDocument(await fs.readTextFile(markerPath));
  if (document.product.file !== sourcePath.slice(slash + 1)) return null;
  const paths = [
    sourcePath,
    markerPath,
    ...document.members
      .filter((member) => member.role === 'sequence-snapshot')
      .map((member) => fromPackageRelative(member.path, packageRoot)),
  ];
  const journal = sequencePackagePaths(packageRoot).revisionJournalPath;
  if (await fs.exists(journal)) paths.push(journal);
  return [...new Set(paths)];
}

export async function refreshSavedSequenceSession(document: SavedSequenceDocument): Promise<void> {
  const { refreshElectronWorkspaceSessionForPath } =
    await import('../features/workspace-session/public/electron-session');
  await refreshElectronWorkspaceSessionForPath(document.sourcePath, null);
}
