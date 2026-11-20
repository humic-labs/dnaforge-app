import { useEffect, useState } from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import { Button } from '../../components/ui';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { platform } from '../../platform';
import {
  WORKSPACE_RECONCILED_EVENT,
  type WorkspaceReconciledEventDetail,
} from '../../services/workspace-reconciled-event';
import type { SourceFileView } from '../../shared/external-preview';
import { MOLECULAR_DOCUMENT_SUFFIX } from '../../shared/molecular-document';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { StructurePreview } from './StructurePreview';

export function ProjectStructureFile({ view, tabId }: { view: SourceFileView; tabId: string }) {
  const { path, workspaceRoot, expectedSourceSha256 } = view;
  const openRoot = useWorkspaceStore((s) => findWorkspaceRootForPath(s.folders, path));
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'loose' | { error: string }>('loading');
  const isPackage = path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX);

  useEffect(() => {
    if (isPackage) return;
    const onReconciled = (event: Event) => {
      const { workspaceRoot: changedRoot } = (event as CustomEvent<WorkspaceReconciledEventDetail>)
        .detail;
      if (findWorkspaceRootForPath([{ path: changedRoot }], path)) setAttempt((value) => value + 1);
    };
    window.addEventListener(WORKSPACE_RECONCILED_EVENT, onReconciled);
    return () => window.removeEventListener(WORKSPACE_RECONCILED_EVENT, onReconciled);
  }, [isPackage, path]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState((current) => (current === 'loose' ? current : 'loading'));

    async function restore() {
      const root =
        workspaceRoot ??
        openRoot ??
        findWorkspaceRootForPath(
          (await platform().workspace.listRegisteredProjects?.()) ?? [],
          path
        );
      if (signal.aborted) return;
      if (!root) {
        setState({ error: 'Reopen the project that contains this structure in Files.' });
        return;
      }
      const location = isPackage
        ? { path, workspaceRoot: root }
        : await platform().molecularDocuments.resolveImportedCoordinate({
            path,
            workspaceRoot: root,
            expectedSourceSha256,
          });
      if (signal.aborted) return;
      if (!location) {
        const exists = await platform().fs.exists(path);
        if (!signal.aborted)
          setState(
            exists
              ? 'loose'
              : {
                  error:
                    'Could not identify a unique saved structure for this file. Open its molecular document from Files.',
                }
          );
        return;
      }
      const { openMolecularDocument } = await import('../molecular-documents/public/open');
      const result = await openMolecularDocument(location.path, {
        workspaceRoot: location.workspaceRoot,
        replaceProjectSource: { tabId, sourcePath: path },
        signal,
      });
      if (!signal.aborted && result.status !== 'presented' && result.status !== 'cancelled')
        setState({ error: result.message });
    }

    void restore().catch((error: unknown) => {
      if (!signal.aborted)
        setState({
          error: toUserMessage(error, 'failure.the-saved-molecular-view-could-not-open'),
        });
    });
    return () => controller.abort();
  }, [path, workspaceRoot, openRoot, expectedSourceSha256, tabId, attempt, isPackage]);

  if (state === 'loose')
    return <StructurePreview path={path} expectedSourceSha256={expectedSourceSha256} />;
  if (state === 'loading')
    return (
      <p className="p-4 text-sm text-fg-muted" role="status">
        Opening project structure…
      </p>
    );
  return (
    <div className="p-4 text-sm">
      <p role="alert" className="mb-2">
        {state.error}
      </p>
      <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
    </div>
  );
}
