import { useCallback, useRef, useState, type ComponentType } from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import { Button } from '../../components/ui';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { platform } from '../../platform';
import {
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from '../../services/workspace-files-changed-event';
import { readRetainedPreview } from '../../lib/preview-tab-packages';
import type { SourceViewerTab } from '../../lib/open-external-preview';
import type { PromoteQuickLookPackageResult } from '../../shared/file-association-ipc';
import { promotePreviewTab } from './promote-preview-tab';
import { LegacyExternalPreview } from './LegacyExternalPreview';
import type { SourceViewerFormat } from '../../shared/external-preview';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public/store';
import { ImportDestinationPicker } from '../import-wizard/ImportDestinationPicker';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';
import { FastaPreview } from './FastaPreview';
import { StructurePreview } from './StructurePreview';
import { ProjectStructureFile } from './ProjectStructureFile';
import { ChromatogramPreview } from './ChromatogramPreview';
import type { PreviewProps } from './use-preview-source';

const viewers: Record<SourceViewerFormat, ComponentType<PreviewProps>> = {
  fasta: FastaPreview,
  structure: StructurePreview,
  chromatogram: ChromatogramPreview,
};

async function listSubfolders(path: string) {
  const entries = await platform().fs.readDir(path);
  return entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: `${path}/${entry.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function SourceFileViewer({ view, tabId }: { view: SourceViewerTab; tabId: string }) {
  const [digest, setDigest] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState<ImportDestination>({ kind: 'new-workspace' });
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const folders = useWorkspaceStore((s) => s.folders);
  const saved = useRef<PromoteQuickLookPackageResult | null>(null);
  const Viewer = viewers[view.format];
  const receipt = view.receipt;
  const { workspaceRoot, path, projectPackageId } = view;
  const read = useCallback(async () => {
    if (receipt) {
      return readRetainedPreview(receipt);
    }
    if (!workspaceRoot || !projectPackageId) throw new Error('Open the saved document from Files.');
    return platform().fileAssociations.readProjectPreviewPresentation({
      workspaceRoot,
      path,
      expectedPackageId: projectPackageId,
    });
  }, [receipt, projectPackageId, path, workspaceRoot]);
  function selectRecord(index: number) {
    const state = useCanvasStore.getState();
    const panel = Object.values(state.panels).find((p) => p.tabs.some((tab) => tab.id === tabId));
    if (panel)
      state.updateTab(panel.id, tabId, { sourceFileView: { ...view, selectedRecord: index } });
  }
  const props: PreviewProps = {
    path: view.sourceFileName ?? path,
    readPackage: receipt || projectPackageId ? read : undefined,
    recordIndex: view.selectedRecord,
    onRecordChange: selectRecord,
  };
  if (view.location === 'project')
    return view.format === 'structure' ? (
      <ProjectStructureFile view={view} tabId={tabId} />
    ) : (
      <Viewer {...props} />
    );
  if (!receipt) return <LegacyExternalPreview view={view} tabId={tabId} />;

  async function importFile() {
    if (
      !receipt ||
      digest !== receipt.contentHash ||
      !target ||
      target.kind === 'registry' ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const result =
        saved.current ??
        (await platform().fileAssociations.savePreview({
          receipt,
          destination:
            target.kind === 'new-workspace'
              ? {
                  kind: 'new-workspace',
                  name: receipt.sourceFileName.replace(/\.[^.]+$/, '') || receipt.sourceFileName,
                }
              : { kind: 'existing-workspace', rootPath: target.rootPath },
        }));
      saved.current = result;
      const detail: WorkspaceFilesChangedDetail = {
        workspaceRoot:
          findWorkspaceRootForPath(folders, result.workspaceRoot) ?? result.workspaceRoot,
        createdNewWorkspace: result.createdNewWorkspace,
        createdWorkspaceName: result.createdWorkspaceName ?? undefined,
        revealPaths: [result.destPath],
      };
      window.dispatchEvent(
        new CustomEvent<WorkspaceFilesChangedDetail>(WORKSPACE_FILES_CHANGED_EVENT, { detail })
      );
      await promotePreviewTab(
        receipt,
        { ...result, workspaceRoot: detail.workspaceRoot ?? result.workspaceRoot },
        tabId
      );
    } catch (cause) {
      setError(
        saved.current
          ? 'The project package was saved. Retry opening it, or open it from Files.'
          : toUserMessage(cause, 'file.previewImportFailed')
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const action = (
    <Button
      type="button"
      variant="appbar"
      disabled={!digest || pending || choosing}
      onClick={() => {
        setChoosing(true);
        setError('');
      }}
    >
      Import to Project…
    </Button>
  );
  const destination = choosing && (
    <section
      aria-label="Import destination"
      className="max-h-[50%] shrink-0 overflow-auto border-b border-border bg-bg-subtle p-3"
    >
      <h2 className="mb-2 text-sm font-semibold text-fg">Add a copy to a project</h2>
      <ImportDestinationPicker
        autoFocus
        roots={folders.filter((f) => !f.pinned).map((f) => ({ name: f.name, path: f.path }))}
        selected={target}
        onSelect={setTarget}
        listSubfolders={listSubfolders}
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-fg">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="primary"
          disabled={!target || !digest || pending}
          onClick={() => void importFile()}
        >
          {pending ? 'Importing…' : saved.current ? 'Open Destination' : 'Import'}
        </Button>
        <Button type="button" disabled={pending} onClick={() => setChoosing(false)}>
          Cancel
        </Button>
      </div>
    </section>
  );

  return (
    <section
      aria-label="External file preview"
      data-testid="external-preview-frame"
      className="h-full min-h-0"
    >
      <Viewer {...props} onSnapshot={setDigest} controls={{ action, destination }} />
    </section>
  );
}
