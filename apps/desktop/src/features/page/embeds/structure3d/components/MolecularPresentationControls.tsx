import {
  toUserMessage,
  userMessage,
  userMessagePayload,
  withUserMessage,
} from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { usePageStore } from '../../../store';
import { useWorkspaceStore } from '../../../../../stores/workspaceStore';
import { writableProjectRoots } from '../../../../../shared/project-root-selection';
import type { DBEntityReference } from '../../../../../db/entity-references';
import { getEntityReferenceByLocator } from '../../../../../db/entity-references';
import { findWorkspaceRootForPath } from '../../../../../db/workspace-catalog';
import { platform } from '../../../../../platform';
import type { MolstarPlugin } from '../molstar/cache';
import type { Structure3dAttrs } from '../types';
import {
  captureMolViewSpecView,
  sameLoadedMolViewSpecScene,
  activeMolViewSpecScene,
} from '../molstar/molViewSpec';
import { molViewSpecStorySteps } from '../utils/molViewSpecStory';
import {
  molecularViewFromReferenceData,
  sameMolecularViewData,
  type MolecularView,
} from '../utils/molecularView';
import { samePresentationAppearance } from '../utils/molecularPresentation';
import { isDefaultMolecularScene } from '../../../../../shared/default-molecular-view';
import { useStructure3dStore } from '../store';
import { MolecularViewNavigation } from './MolecularViewNavigation';
import { STRUCTURE_VIEWER_BUTTON_CLASS } from './structureViewerStyles';

const button = STRUCTURE_VIEWER_BUTTON_CLASS;
type Props = {
  structureId: string;
  attrs: Structure3dAttrs;
  plugin: MolstarPlugin | null;
  ready: boolean;
  onSelect: (index: number) => void;
  onRestore: (reference: DBEntityReference, view: MolecularView) => void;
};

function matchesCapturedView(
  view: MolecularView,
  current: ReturnType<typeof captureMolViewSpecView>,
  attrs: Structure3dAttrs
): boolean {
  const savedAssets = view.version === 2 ? view.pinnedAssets : [];
  const currentAssets = new Map(current.pinnedAssets.map((asset) => [asset.name, asset]));
  return (
    samePresentationAppearance(view.scene, current.scene) &&
    view.coordinates.format === current.coordinates.format &&
    view.coordinates.text === current.coordinates.text &&
    sameMolecularViewData(view, attrs) &&
    savedAssets.length === currentAssets.size &&
    savedAssets.every((saved) => {
      const asset = currentAssets.get(saved.name);
      return (
        asset &&
        saved.format === asset.format &&
        saved.text === asset.text &&
        saved.sha256 === asset.sha256 &&
        saved.label === asset.label &&
        saved.sourceReferenceId === asset.sourceReferenceId
      );
    })
  );
}

async function readHistory(
  referenceId: string,
  documentPath: string | undefined,
  folders: Array<{ path: string }>
): Promise<DBEntityReference[]> {
  if (!documentPath)
    throw withUserMessage(
      Error(
        'This legacy result has no verified document binding. Reopen it through its molecular document reference.'
      ),
      'molecular.documentUnlinked'
    );
  const workspaceRoot =
    findWorkspaceRootForPath(folders, documentPath) ?? documentPath.replace(/[\\/][^\\/]+$/, '');
  const saved = await platform().molecularDocuments.read({ path: documentPath, workspaceRoot });
  const entries: DBEntityReference[] = saved.document.history.map((entry) => ({
    id: entry.referenceId,
    entity_type: 'structure',
    display_label: entry.snapshot.title,
    locator: `entity://structure/saved-view:${entry.referenceId}`,
    data: JSON.stringify(entry.snapshot),
    deep_link_params: null,
    source: 'user',
    status: 'created',
    workspace_scope: null,
    workspace_root_path: saved.workspaceRoot,
    created_at: entry.snapshot.createdAt,
    updated_at: entry.snapshot.createdAt,
  }));
  return entries;
}

async function readDocumentPresentation(
  referenceId: string,
  path: string | undefined,
  folders: Array<{ path: string }>
) {
  const reference = (await readHistory(referenceId, path, folders)).find(
    (entry) => entry.id === referenceId
  );
  const view = reference && molecularViewFromReferenceData(reference.data);
  if (!reference || !view)
    throw withUserMessage(
      Error('The requested molecular document revision is unavailable.'),
      'guidance.the-requested-molecular-document-revision-is-unavailable'
    );
  return { reference, view };
}

export function MolecularPresentationControls({
  structureId,
  attrs,
  plugin,
  ready,
  onSelect,
  onRestore,
}: Props) {
  const [panel, setPanel] = useState<'history' | 'notebook' | null>(null);
  const notebooks = usePageStore((state) => state.pageList);
  const folders = useWorkspaceStore((state) => state.folders);
  const roots = writableProjectRoots(folders);
  const [notebookId, setNotebookId] = useState('new');
  const [notebookTitle, setNotebookTitle] = useState('');
  const [notebookRoot, setNotebookRoot] = useState('');
  const [base, setBase] = useState<{ reference: DBEntityReference; view: MolecularView } | null>(
    null
  );
  const [projectBase, setProjectBase] = useState<{
    referenceId: string;
    view: MolecularView;
  } | null>(null);
  const [projectSave, setProjectSave] = useState<{
    structureId: string;
    previousReferenceId: string | undefined;
    referenceId: string;
  } | null>(null);
  const [history, setHistory] = useState<DBEntityReference[]>([]);
  const [dirty, setDirty] = useState(
    () =>
      !(
        attrs.molecularDocumentId &&
        attrs.molecularDocumentPath &&
        attrs.molecularDocumentRevision &&
        attrs.molecularDocumentSavedReferenceId
      )
  );
  const owner = JSON.stringify([structureId, attrs.molecularDocumentPath]);
  const baseOwner = useRef(owner);
  const projectBaseOwner = useRef(owner);
  const defaultViewBaseline = useRef<{ owner: string; scene: string } | null>(null);
  const [nativeReadyFor, setNativeReadyFor] = useState<{
    plugin: MolstarPlugin;
    scene: string | undefined;
    index: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<DBEntityReference | null>(null);
  const steps = molViewSpecStorySteps(attrs.molViewSpec);
  const title = base?.view.title ?? attrs.label ?? attrs.title ?? 'Molecular visualization';
  const caption = base?.view.caption ?? attrs.description ?? '';
  const nativeProjectReferenceId =
    attrs.molecularDocumentId &&
    attrs.molecularDocumentPath &&
    attrs.molecularDocumentRevision &&
    attrs.molecularDocumentSavedReferenceId
      ? attrs.molecularDocumentSavedReferenceId
      : undefined;

  const projectReferenceId =
    projectSave?.structureId === structureId &&
    projectSave.previousReferenceId === nativeProjectReferenceId
      ? projectSave.referenceId
      : nativeProjectReferenceId;
  const projectBaselinePending =
    !!projectReferenceId && projectBase?.referenceId !== projectReferenceId;

  const nativeReady =
    ready &&
    !!plugin &&
    (!attrs.molViewSpec ||
      (nativeReadyFor?.plugin === plugin &&
        nativeReadyFor.scene === attrs.molViewSpec &&
        nativeReadyFor.index === (attrs.molViewSpecSnapshotIndex ?? 0)));

  useEffect(() => {
    let cancelled = false;
    if (baseOwner.current !== owner) {
      baseOwner.current = owner;
      setBase(null);
      setHistory([]);
    }
    setError(null);
    void (async () => {
      const id =
        attrs.molViewSpecSavedReferenceId ??
        (structureId.startsWith('saved-view:')
          ? (await getEntityReferenceByLocator(`entity://structure/${structureId}`))?.id
          : undefined);
      if (!id) return;
      const entries = await readHistory(id, attrs.molecularDocumentPath, folders);
      const saved = await readDocumentPresentation(id, attrs.molecularDocumentPath, folders);
      if (!cancelled) {
        setBase(saved);
        setHistory(entries);
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        setDirty(true);
        setError(toUserMessage(error, 'failure.could-not-load-saved-presentation'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    attrs.molViewSpecSavedReferenceId,
    attrs.molecularViewSnapshot,
    attrs.molecularDocumentPath,
    attrs.molecularDocumentRevision,
    folders,
    owner,
    structureId,
  ]);

  useEffect(() => setWarning(null), [structureId]);

  useEffect(() => {
    let cancelled = false;
    if (projectBaseOwner.current !== owner || !projectReferenceId) {
      projectBaseOwner.current = owner;
      setProjectBase(null);
    }
    if (projectReferenceId)
      void readDocumentPresentation(projectReferenceId, attrs.molecularDocumentPath, folders)
        .then(({ reference, view }) => {
          if (!cancelled) setProjectBase({ referenceId: reference.id, view });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setDirty(true);
            setError(toUserMessage(error, 'failure.could-not-load-the-saved-view'));
          }
        });
    return () => {
      cancelled = true;
    };
  }, [projectReferenceId, structureId, attrs.molecularDocumentPath, folders, owner]);

  useEffect(() => {
    if (!plugin || !ready) {
      setNativeReadyFor(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let awaitingNative = true;
    let observedScene: string | undefined;
    let observedCamera: string | undefined;
    const check = () => {
      timer = undefined;
      if (!base && !projectBase && !attrs.molViewSpec) {
        setDirty(true);
        awaitingNative = false;
        return;
      }
      if (!sameLoadedMolViewSpecScene(activeMolViewSpecScene(plugin), attrs.molViewSpec)) {
        setNativeReadyFor(null);
        awaitingNative = true;
        return;
      }
      try {
        const current = captureMolViewSpecView(plugin, {
          cameraPolicy: 'preserve-authored',
          authoredCameraSnapshot: attrs.cameraSnapshot,
        });
        if ((current.initialSnapshotIndex ?? 0) !== (attrs.molViewSpecSnapshotIndex ?? 0)) {
          setNativeReadyFor(null);
          awaitingNative = true;
          return;
        }
        setNativeReadyFor((previous) =>
          previous?.plugin === plugin &&
          previous.scene === attrs.molViewSpec &&
          previous.index === (attrs.molViewSpecSnapshotIndex ?? 0)
            ? previous
            : { plugin, scene: attrs.molViewSpec, index: attrs.molViewSpecSnapshotIndex ?? 0 }
        );

        if (
          projectBaselinePending ||
          (!projectReferenceId && attrs.molViewSpecSavedReferenceId && !base)
        ) {
          awaitingNative = false;
          return;
        }
        const savedView = projectReferenceId ? projectBase?.view : base?.view;
        if (savedView && !attrs.molViewSpec && isDefaultMolecularScene(savedView.scene)) {
          if (defaultViewBaseline.current?.owner !== owner)
            defaultViewBaseline.current = { owner, scene: current.scene };
          setDirty(!samePresentationAppearance(defaultViewBaseline.current.scene, current.scene));
        } else {
          setDirty(!savedView || !matchesCapturedView(savedView, current, attrs));
        }
        awaitingNative = false;
      } catch {
        setNativeReadyFor(null);

        awaitingNative = true;
      }
    };
    const schedule = () => {
      const scene = activeMolViewSpecScene(plugin);
      const camera = JSON.stringify(plugin.canvas3d?.camera.getSnapshot?.());
      if (scene !== observedScene || camera !== observedCamera) {
        observedScene = scene;
        observedCamera = camera;
        clearTimeout(timer);
        timer = setTimeout(check, 180);
      } else if (awaitingNative && timer === undefined) {
        timer = setTimeout(check, 180);
      }
    };
    check();
    const sub = plugin.canvas3d?.camera.stateChanged.subscribe(schedule);
    const draw = plugin.canvas3d?.didDraw?.subscribe(schedule);
    return () => {
      clearTimeout(timer);
      sub?.unsubscribe();
      draw?.unsubscribe();
    };
  }, [
    plugin,
    ready,
    base,
    projectBase,
    projectReferenceId,
    projectBaselinePending,
    attrs.molViewSpec,
    attrs.molViewSpecSnapshotIndex,
    attrs.cameraSnapshot,
    attrs.molViewSpecSavedReferenceId,
    attrs.measurements,
    attrs.activeMeasurementId,
    attrs.molecularData,
    owner,
  ]);

  const matchesCurrentView = (
    view: MolecularView,
    cameraPolicy: 'capture-current' | 'preserve-authored',
    includeOpeningView = false
  ) => {
    if (!plugin || !ready) return false;
    try {
      const currentAttrs =
        useStructure3dStore.getState().expandedStructures[structureId]?.data ?? attrs;
      const current = captureMolViewSpecView(plugin, {
        cameraPolicy,
        authoredCameraSnapshot: currentAttrs.cameraSnapshot,
      });
      return (
        sameLoadedMolViewSpecScene(activeMolViewSpecScene(plugin), currentAttrs.molViewSpec) &&
        matchesCapturedView(view, current, currentAttrs) &&
        (!includeOpeningView ||
          (view.initialSnapshotIndex ?? 0) === (current.initialSnapshotIndex ?? 0))
      );
    } catch {
      return false;
    }
  };

  const save = async () => {
    if (!nativeReady || busy || !dirty || projectBaselinePending) return;
    if (projectBase && matchesCurrentView(projectBase.view, 'preserve-authored')) {
      setDirty(false);
      return;
    }
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const { handleMolSaveView } = await import('../../../../agent-bridge/public/structure-tools');
      const result = await handleMolSaveView(
        {
          structureViewId: structureId,
          title,
          caption,
          evidence: base?.view.evidence ?? [],
          saveToProject: true,
        },
        { cameraPolicy: 'preserve-authored' }
      );
      if (!result.ok)
        throw withUserMessage(
          Error(result.error),
          result.userMessagePayload ??
            userMessagePayload('failure.could-not-save-the-molecular-view')
        );
      if (
        !result.molecularDocumentId ||
        !result.molecularDocumentPath ||
        !result.molecularDocumentRevision
      )
        throw Error('The view was captured, but no project document was saved.');
      setProjectSave({
        structureId,
        previousReferenceId: nativeProjectReferenceId,
        referenceId: result.revisionId,
      });
      setWarning(result.warning ?? null);
      const saved = await readDocumentPresentation(
        result.revisionId,
        result.molecularDocumentPath,
        folders
      );
      setBase(saved);
      setProjectBase({ referenceId: saved.reference.id, view: saved.view });
      setDirty(!matchesCurrentView(saved.view, 'preserve-authored'));
      setHistory(await readHistory(result.revisionId, result.molecularDocumentPath, folders));
      setPanel(null);
    } catch (error) {
      setError(toUserMessage(error, 'failure.could-not-save-the-molecular-view'));
    } finally {
      setBusy(false);
    }
  };
  const restore = (reference: DBEntityReference) => {
    const view = molecularViewFromReferenceData(reference.data);
    if (!view) {
      setError(userMessage('failure.the-saved-presentation-is-unavailable'));
      return;
    }
    onRestore(reference, view);
    setConfirmRestore(null);
    setPanel(null);
    setError(null);
  };
  const openNotebook = () => {
    setNotebookId('new');
    setNotebookTitle(`${title} notes`);
    setNotebookRoot(
      findWorkspaceRootForPath(roots, attrs.molecularDocumentPath ?? attrs.coordinateFilePath) ??
        (roots.length === 1 ? roots[0].path : '')
    );
    setPanel(panel === 'notebook' ? null : 'notebook');
    setError(null);
    void usePageStore
      .getState()
      .fetchPages()
      .catch((error: unknown) =>
        setError(toUserMessage(error, 'failure.could-not-load-notebooks'))
      );
  };
  const recordNotebook = async () => {
    if (!nativeReady || busy) return;
    setBusy(true);
    setError(null);
    try {
      let snapshot = base;
      let documentReference = (
        await (
          await import('../../../../molecular-documents/public/services')
        ).inspectMolecularDocumentBinding(
          useStructure3dStore.getState().expandedStructures[structureId]?.data ?? attrs
        )
      ).documentReference;
      if (!snapshot || !matchesCurrentView(snapshot.view, 'capture-current', true)) {
        const { handleMolSaveView } =
          await import('../../../../agent-bridge/public/structure-tools');
        const result = await handleMolSaveView({
          structureViewId: structureId,
          title,
          caption,
          evidence: base?.view.evidence ?? [],
        });
        if (!result.ok) throw Error(result.error);
        documentReference = result.documentReference;
        snapshot = await readDocumentPresentation(
          result.revisionId,
          result.molecularDocumentPath,
          folders
        );
        setBase(snapshot);
        setHistory(await readHistory(result.revisionId, result.molecularDocumentPath, folders));
      }
      const { captureMolecularPresentationToNotebook } =
        await import('../../../molecular-presentation-notebook');
      const result = await captureMolecularPresentationToNotebook(
        snapshot.reference.id,
        notebookId === 'new'
          ? {
              documentReference,
              newNotebookTitle: notebookTitle,
              ...(notebookRoot ? { workspaceRoot: notebookRoot } : {}),
            }
          : { pageId: notebookId, documentReference }
      );
      const { navigateToReference } = await import('../../../../ai/public/navigate-to-reference');
      await navigateToReference(result.reference);
      setPanel(null);
    } catch (error) {
      setError(toUserMessage(error, 'failure.could-not-record-the-molecular-view'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="relative flex min-w-0 max-w-full flex-1 basis-52 items-center gap-1.5"
      data-testid="molecular-presentation-controls"
      data-save-state={dirty ? 'Unsaved changes' : 'Saved'}
    >
      {attrs.molViewSpec && steps.length > 1 && (
        <MolecularViewNavigation
          scene={attrs.molViewSpec}
          activeIndex={attrs.molViewSpecSnapshotIndex ?? 0}
          onSelect={onSelect}
          disabled={!ready || busy}
        />
      )}
      <button
        type="button"
        className={button}
        disabled={!nativeReady || busy}
        title="Record the current view in a notebook"
        onClick={openNotebook}
        data-testid="presentation-notebook"
      >
        Notebook
      </button>
      {base && (
        <button
          type="button"
          className={button}
          aria-expanded={panel === 'history'}
          onClick={() => {
            setPanel(panel === 'history' ? null : 'history');
            setConfirmRestore(null);
          }}
          data-testid="presentation-history"
        >
          History
        </button>
      )}
      <button
        type="button"
        className={button}
        disabled={!nativeReady || busy || !dirty || projectBaselinePending}
        onClick={() => void save()}
        data-testid="presentation-save"
      >
        Save
      </button>
      {dirty && (
        <span
          role="status"
          data-testid="presentation-save-state"
          className="min-w-0 truncate text-[10px] text-fg-muted"
        >
          Unsaved changes
        </span>
      )}
      {(panel || error || warning) && (
        <div
          className="absolute left-0 top-full z-40 mt-2 grid max-h-[70vh] w-80 max-w-full gap-2 overflow-auto rounded-lg border border-border bg-bg p-3 text-xs text-fg shadow-lg"
          data-testid="presentation-popover"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">
              {panel === 'notebook'
                ? 'Record in notebook'
                : panel === 'history'
                  ? 'Saved revisions'
                  : 'Molecular view'}
            </span>
            <button
              type="button"
              aria-label="Close presentation controls"
              onClick={() => {
                setPanel(null);
                setError(null);
                setWarning(null);
              }}
              className="text-fg-muted"
            >
              ×
            </button>
          </div>
          {error && (
            <p role="alert" className="text-error">
              {toUserMessage(error, 'structure.failed')}
            </p>
          )}
          {warning && (
            <p role="status" className="text-fg-muted" data-testid="presentation-save-warning">
              {warning}
            </p>
          )}
          {panel === 'notebook' && (
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void recordNotebook();
              }}
            >
              <p className="text-fg-muted">
                Records the current visualization with all named views and pinned coordinates.
              </p>
              <label className="grid gap-1">
                Notebook
                <select
                  aria-label="Notebook destination"
                  value={notebookId}
                  onChange={(event) => setNotebookId(event.target.value)}
                  className="rounded border border-border bg-bg px-2 py-1"
                >
                  <option value="new">New notebook</option>
                  {notebooks.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title}
                    </option>
                  ))}
                </select>
              </label>
              {notebookId === 'new' && (
                <>
                  <label className="grid gap-1">
                    Title
                    <input
                      aria-label="New notebook title"
                      value={notebookTitle}
                      onChange={(event) => setNotebookTitle(event.target.value)}
                      required
                      maxLength={200}
                      className="rounded border border-border bg-bg px-2 py-1"
                    />
                  </label>
                  {roots.length > 1 && (
                    <label className="grid gap-1">
                      Project
                      <select
                        aria-label="Notebook project"
                        value={notebookRoot}
                        onChange={(event) => setNotebookRoot(event.target.value)}
                        required
                        className="rounded border border-border bg-bg px-2 py-1"
                      >
                        <option value="">Choose project</option>
                        {roots.map((root) => (
                          <option key={root.path} value={root.path}>
                            {root.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              <button
                type="submit"
                disabled={
                  !nativeReady ||
                  busy ||
                  (notebookId === 'new' &&
                    (!notebookTitle.trim() || (roots.length > 1 && !notebookRoot)))
                }
                className={`${button} justify-self-end`}
                data-testid="presentation-confirm-notebook"
              >
                {busy ? 'Recording…' : 'Record and open notebook'}
              </button>
            </form>
          )}
          {panel === 'history' && (
            <>
              <p className="text-fg-muted">
                Each save preserves every named view. Restore changes your working presentation.
              </p>
              <ul aria-label="Saved revisions" className="divide-y divide-border">
                {[...history].reverse().map((reference) => {
                  const view = molecularViewFromReferenceData(reference.data);
                  if (!view) return null;
                  const parent = history.findIndex(
                    (entry) => entry.id === view.presentation?.parentReferenceId
                  );
                  return (
                    <li
                      key={reference.id}
                      className="flex items-start justify-between gap-3 py-2"
                      data-reference-id={reference.id}
                    >
                      <div className="grid min-w-0 gap-1">
                        <span className="font-medium">
                          Revision {history.indexOf(reference) + 1}
                          {reference.id === base?.reference.id ? ' · Current' : ''}
                        </span>
                        <span>{reference.display_label}</span>
                        {view.presentation?.changeSummary && (
                          <span className="text-fg-muted">{view.presentation.changeSummary}</span>
                        )}
                        <span className="text-[10px] text-fg-muted">
                          {new Date(reference.created_at).toLocaleString()}
                          {parent >= 0 ? ` · From revision ${parent + 1}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={button}
                        disabled={!ready || busy}
                        data-testid="presentation-restore"
                        onClick={() =>
                          base && !matchesCurrentView(base.view, 'preserve-authored')
                            ? setConfirmRestore(reference)
                            : restore(reference)
                        }
                      >
                        Restore
                      </button>
                    </li>
                  );
                })}
              </ul>
              {confirmRestore && (
                <div className="grid gap-2 border-t border-border py-2" role="alert">
                  <p>
                    Restore this revision? Unsaved changes in the working presentation will be
                    replaced.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className={button}
                      onClick={() => setConfirmRestore(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={button}
                      onClick={() => restore(confirmRestore)}
                      data-testid="presentation-confirm-restore"
                    >
                      Restore revision
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
