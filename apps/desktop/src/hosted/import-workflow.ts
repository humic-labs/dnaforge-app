import type { TabType } from '../features/canvas/types';
import { getTabTypeForFile } from '../utils/fileTypes';

export interface HostedImportResult {
  workspaceId: string;
  paths: string[];
}

export interface HostedImportWorkflowDependencies {
  handleFileSelect: (path: string, tabType: TabType) => Promise<unknown>;
  bumpFileTreeRefresh: () => void;
  revealPath: (path: string) => void;
  setStatus: (status: string | null) => void;
  importFiles?: (files: readonly File[]) => Promise<HostedImportResult>;
  getTabType?: (path: string) => TabType;
}

async function importHostedFiles(files: readonly File[]): Promise<HostedImportResult> {
  const { importHostedSequenceFiles } = await import('./import-files');
  return importHostedSequenceFiles(files);
}

export async function runHostedImport(
  files: readonly File[],
  dependencies: HostedImportWorkflowDependencies
): Promise<void> {
  if (files.length === 0) return;

  dependencies.setStatus('Importing…');
  try {
    const imported = await (dependencies.importFiles ?? importHostedFiles)(files);
    dependencies.bumpFileTreeRefresh();
    const tabTypeForFile = dependencies.getTabType ?? getTabTypeForFile;

    for (const path of imported.paths) {
      await dependencies.handleFileSelect(path, tabTypeForFile(path));
    }

    const firstPath = imported.paths[0];
    if (firstPath) {
      await dependencies.handleFileSelect(firstPath, tabTypeForFile(firstPath));
      dependencies.revealPath(firstPath);
    }

    dependencies.setStatus(
      `Imported ${files.length === 1 ? files[0].name : `${files.length} files`}.`
    );
  } catch (error: unknown) {
    dependencies.setStatus(error instanceof Error ? error.message : 'Import failed.');
  }
}
