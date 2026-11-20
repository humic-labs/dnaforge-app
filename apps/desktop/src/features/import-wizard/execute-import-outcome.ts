import { planImportWrites } from './plan-import-writes';
import { resolveItemTarget, type ImportItemTarget } from './import-item-target';
import type { ImportWizardOutcome } from './import-wizard-store';
import type { ImportFileRequest, ImportFileResult } from '../../shared/workspace-git-types';
import type { ImportReviewReceipt } from '../../shared/import-review';

export interface ImportExecDeps {
  importRecords?: (request: {
    review: { id: string; revision: string };
    targetRoot: string;
  }) => Promise<{ workspaceRoot: string; receipt: ImportReviewReceipt }>;
  importFile: (request: ImportFileRequest) => Promise<ImportFileResult>;
  importCapturedFileAsNewWorkspace?: (
    sourcePath: string,
    name: string
  ) => Promise<{ workspaceRoot: string; file: ImportFileResult }>;
  importFolder: (request: { targetRoot: string; sourcePath: string }) => Promise<ImportFileResult>;
  importManaged: (request: { sourcePath: string }) => Promise<{ repoPath: string }>;
  importFileAsNewWorkspace: (request: { sourcePath: string }) => Promise<{ repoPath: string }>;
  createEmptyWorkspace: (request: { name?: string }) => Promise<{ rootPath: string }>;
  registerImportedSequence: (request: {
    sourcePath: string;
    targetRoot: string;
    dedup?: ImportFileRequest['dedup'];
    expectedSourceSha256?: string;
    confirmedDnaSourceSha256?: string;
    confirmedNucleicAcid?: import('@waypoint/sequence-utils').NucleicAcid;
  }) => Promise<{
    destPath: string;
    registered: boolean;
    batchId: string | null;
    entityIds: string[];
    packageProductPaths?: string[];
    copySkipped?: boolean;
    reason?: string;
  }>;
}

export interface ImportExecError {
  sourcePath: string;
  error: string;
}

export interface ImportExecResult {
  imported: number;
  skipped: number;
  skipBreakdown?: { duplicates: number; validation: number };
  failed: number;
  errors: ImportExecError[];
  written: { sourcePath: string; destPath: string }[];
  workspaceRoot?: string;
  createdNewWorkspace?: boolean;
  createdWorkspaceName?: string;
  touchedRoots?: string[];
  registryChanged?: boolean;
}

function deriveNewWorkspaceName(outcome: ImportWizardOutcome): string {
  const importable = outcome.items.filter((i) => !i.block);
  if (importable.length === 1 && importable[0].kind === 'folder') return importable[0].name;
  return 'Imported files';
}

export async function executeImportOutcome(
  originalOutcome: ImportWizardOutcome,
  deps: ImportExecDeps
): Promise<ImportExecResult> {
  const result: ImportExecResult = { imported: 0, skipped: 0, failed: 0, errors: [], written: [] };
  const recordSkip = (reason: 'duplicates' | 'validation'): void => {
    result.skipped += 1;
    result.skipBreakdown ??= { duplicates: 0, validation: 0 };
    result.skipBreakdown[reason] += 1;
  };

  const resolvedBatch = originalOutcome.destination;
  const anyNewWorkspace = originalOutcome.items.some(
    (i) => resolveItemTarget(i.target, resolvedBatch).kind === 'new-workspace'
  );
  const publishFirstPackage =
    deps.importCapturedFileAsNewWorkspace &&
    !originalOutcome.importIntent &&
    originalOutcome.items.every(
      (item) =>
        item.packageInputPath &&
        resolveItemTarget(item.target, resolvedBatch).kind === 'new-workspace'
    )
      ? deps.importCapturedFileAsNewWorkspace
      : undefined;
  let outcome = originalOutcome;
  if (anyNewWorkspace && !publishFirstPackage) {
    const name = deriveNewWorkspaceName(originalOutcome);
    const { rootPath } = await deps.createEmptyWorkspace({ name });
    result.workspaceRoot = rootPath;
    result.createdNewWorkspace = true;
    result.createdWorkspaceName = name;
    const intoNewWs: ImportItemTarget = { kind: 'existing-root', rootPath };
    outcome = {
      ...originalOutcome,
      destination:
        resolvedBatch.kind === 'new-workspace'
          ? { kind: 'existing-root', rootPath }
          : resolvedBatch,
      items: originalOutcome.items.map((i) =>
        resolveItemTarget(i.target, resolvedBatch).kind === 'new-workspace'
          ? { ...i, target: intoNewWs }
          : i
      ),
    };
  } else if (!publishFirstPackage) {
    result.workspaceRoot =
      resolvedBatch.kind === 'existing-root' ? resolvedBatch.rootPath : undefined;
  }

  let registryRootPromise: Promise<string> | undefined;
  const ensureRegistryRoot = (): Promise<string> => {
    if (result.workspaceRoot) return Promise.resolve(result.workspaceRoot);
    if (!registryRootPromise) {
      registryRootPromise = (async () => {
        const name = deriveNewWorkspaceName(originalOutcome);
        const { rootPath } = await deps.createEmptyWorkspace({ name });
        result.workspaceRoot = rootPath;
        result.createdNewWorkspace = true;
        result.createdWorkspaceName = name;
        return rootPath;
      })();
    }
    return registryRootPromise;
  };

  function recordFile(sourcePath: string, file: ImportFileResult) {
    if (file.skipped) return recordSkip('duplicates');
    const paths = file.packageProductPaths?.length ? file.packageProductPaths : [file.destPath];
    result.imported += paths.length;
    result.written.push(...paths.map((destPath) => ({ sourcePath, destPath })));
  }

  const touched = new Set<string>();
  for (const action of planImportWrites(outcome)) {
    if (action.kind === 'skip') {
      recordSkip(action.reason === 'duplicate' ? 'duplicates' : 'validation');
      continue;
    }
    if (
      action.kind === 'import-file' ||
      action.kind === 'import-folder' ||
      action.kind === 'import-records'
    ) {
      touched.add(action.targetRoot);
    }
    try {
      if (action.kind === 'import-records') {
        if (!deps.importRecords)
          throw new Error('Native spreadsheet record import is unavailable.');
        const { workspaceRoot, receipt } = await deps.importRecords({
          review: action.review,
          targetRoot: action.targetRoot,
        });
        result.imported += receipt.imported;
        result.skipped += receipt.skipped;
        result.failed += receipt.failed;
        result.registryChanged ||= receipt.imported > 0;
        touched.add(workspaceRoot);
        for (const path of [
          ...receipt.artifactPaths,
          ...(receipt.sourcePath ? [receipt.sourcePath] : []),
        ]) {
          result.written.push({
            sourcePath: action.sourcePath,
            destPath: `${workspaceRoot}/${path}`,
          });
        }
        if (receipt.failed > 0)
          result.errors.push({
            sourcePath: action.sourcePath,
            error:
              receipt.partialEffects?.join(' ') ||
              'Some spreadsheet records could not be imported.',
          });
      } else if (action.kind === 'import-file') {
        const r = await deps.importFile({
          targetRoot: action.targetRoot,
          sourcePath: action.sourcePath,
          dedup: action.dedup,
        });
        recordFile(action.sourcePath, r);
      } else if (action.kind === 'import-folder') {
        const r = await deps.importFolder({
          targetRoot: action.targetRoot,
          sourcePath: action.sourcePath,
        });
        result.imported += 1;
        for (const destPath of r.packageProductPaths?.length
          ? r.packageProductPaths
          : [r.destPath]) {
          result.written.push({ sourcePath: action.sourcePath, destPath });
        }
      } else if (action.kind === 'new-workspace-from-folder') {
        const r = await deps.importManaged({ sourcePath: action.sourcePath });
        result.imported += 1;
        result.written.push({ sourcePath: action.sourcePath, destPath: r.repoPath });
      } else if (action.kind === 'new-workspace-then-file' && publishFirstPackage) {
        const path = action.sourcePath;
        if (result.workspaceRoot) {
          recordFile(
            path,
            await deps.importFile({ sourcePath: path, targetRoot: result.workspaceRoot })
          );
        } else {
          const name = deriveNewWorkspaceName(originalOutcome);
          const { workspaceRoot, file } = await publishFirstPackage(path, name);
          result.workspaceRoot = workspaceRoot;
          result.createdNewWorkspace = true;
          result.createdWorkspaceName = name;
          touched.add(workspaceRoot);
          recordFile(path, file);
        }
      } else if (action.kind === 'new-workspace-then-file') {
        const r = await deps.importFileAsNewWorkspace({ sourcePath: action.sourcePath });
        result.imported += 1;
        result.written.push({ sourcePath: action.sourcePath, destPath: r.repoPath });
      } else if (action.kind === 'register-entities') {
        const targetRoot = action.targetRoot ?? (await ensureRegistryRoot());
        touched.add(targetRoot);
        const r = await deps.registerImportedSequence({
          sourcePath: action.sourcePath,
          targetRoot,
          dedup: action.dedup,
          expectedSourceSha256: action.expectedSourceSha256,
          ...(action.confirmedDnaSourceSha256
            ? {
                confirmedDnaSourceSha256: action.confirmedDnaSourceSha256,
                ...(action.confirmedNucleicAcid
                  ? { confirmedNucleicAcid: action.confirmedNucleicAcid }
                  : {}),
              }
            : {}),
        });
        if (r.copySkipped) {
          recordSkip('duplicates');
          continue;
        }
        if (r.registered && r.entityIds.length === 0) {
          throw new Error('Registry import reported success without creating an entity.');
        }
        result.imported += r.registered ? r.entityIds.length : 1;
        for (const destPath of r.packageProductPaths?.length
          ? r.packageProductPaths
          : [r.destPath]) {
          result.written.push({ sourcePath: action.sourcePath, destPath });
        }
        if (!r.registered) {
          result.failed += 1;
          result.errors.push({
            sourcePath: action.sourcePath,
            error: r.reason ?? 'The file was copied, but registry registration did not complete.',
          });
        }
      }
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        sourcePath: action.sourcePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  result.touchedRoots = [...touched];
  return result;
}
