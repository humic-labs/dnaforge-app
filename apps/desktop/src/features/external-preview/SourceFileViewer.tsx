import { useRef, useState, type ComponentType } from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import { Button } from '../../components/ui';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { platform } from '../../platform';
import {
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from '../../services/workspace-files-changed-event';
import type { SourceFileView, SourceViewerFormat } from '../../shared/external-preview';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public/store';
import { ImportDestinationPicker } from '../import-wizard/ImportDestinationPicker';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';
import { FastaPreview } from './FastaPreview';
import { StructurePreview } from './StructurePreview';
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

export function SourceFileViewer({ view, tabId }: { view: SourceFileView; tabId: string }) {
  const [digest, setDigest] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState<ImportDestination>({ kind: 'new-workspace' });
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const folders = useWorkspaceStore((s) => s.folders);
  const Viewer = viewers[view.format];
  if (view.location === 'project') return <Viewer path={view.path} />;

  async function importFile() {
    if (!digest || !target || target.kind === 'registry' || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    const source = {
      sourcePath: view.path,
      preserveOriginal: true as const,
      expectedSourceSha256: digest,
    };
    try {
      let path: string;
      let detail: WorkspaceFilesChangedDetail;
      if (target.kind === 'new-workspace') {
        const result = await platform().workspace.importFileAsNewWorkspace(source);
        if (!result.entryPath) throw new Error('The imported file has no project location.');
        path = result.entryPath;
        detail = {
          workspaceRoot: result.repoPath,
          createdNewWorkspace: true,
          createdWorkspaceName: result.displayName,
        };
      } else {
        const result = await platform().workspace.importFile({
          ...source,
          targetRoot: target.rootPath,
        });
        path = result.destPath;
        detail = { workspaceRoot: findWorkspaceRootForPath(folders, path) ?? target.rootPath };
      }
      const canvas = useCanvasStore.getState();
      const panel = Object.values(canvas.panels).find((p) =>
        p.tabs.some((t) => t.id === tabId && t.sourceFileView?.path === view.path)
      );
      if (panel)
        canvas.retargetTab(
          panel.id,
          tabId,
          { type: 'file', entityId: `source-view:project:${path}` },
          { sourceFileView: { ...view, path, location: 'project' }, readOnly: true }
        );
      window.dispatchEvent(
        new CustomEvent<WorkspaceFilesChangedDetail>(WORKSPACE_FILES_CHANGED_EVENT, {
          detail: { ...detail, revealPaths: [path] },
        })
      );
    } catch (cause) {
      setError(toUserMessage(cause, 'file.previewImportFailed'));
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
          {pending ? 'Importing…' : 'Import'}
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
      <Viewer path={view.path} onSnapshot={setDigest} controls={{ action, destination }} />
    </section>
  );
}
