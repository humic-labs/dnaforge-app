import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextField } from '../../../components/ui';
import type { PortableGenomeViewReference } from '@waypoint/genome-data';
import { EllipsisIcon } from '../../../components/icons';
import { IconButton } from '../../../shared/components/IconButton';
import { useToastStore } from '../../../stores/toast-store';
import type { Tab } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import {
  trackViewIdSchema,
  validateTrackViewDocument,
  type SaveTrackViewRequest,
} from '../../../shared/track-view';
import { saveTrackView } from '../track-view-library';
import { trackViewRecoveryDocument } from '../track-view-recovery-document';
import { openTrackView } from '../open-track-view';
import { TrackViewSaveDialog } from './TrackViewSaveDialog';
import { trackViewMatchesSavedConfiguration } from '../track-view-configuration';
import { useLaneContractStore } from '../lane-contract-store';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { COMMAND_IDS, COMMAND_SCOPES, useCommandHandler } from '../../../commands';
import { contentFingerprint } from '../../../db/entity-substrate/adapter';
import { registerTrackViewControl, type TrackViewSnapshot } from '../track-view-control';

export function TrackViewActions({
  tab,
  referenceName,
  capture,
  capturePortableReference,
  isActive,
  readyForDirtyCheck = true,
}: {
  tab: Tab;
  referenceName: string;
  capture: () => TrackViewSnapshot;
  capturePortableReference?: () => Promise<PortableGenomeViewReference>;
  isActive: boolean;
  readyForDirtyCheck?: boolean;
}) {
  const presentationOverlay = usePresentationOverlay('keyboard');

  const lanes = useLaneContractStore((state) => state.lanesByOwnerId[tab.id]);
  const [name, setName] = useState(tab.trackView?.document.name ?? `${referenceName} view`);
  const [surface, setSurface] = useState<'menu' | 'save' | 'rename' | 'copy' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const pendingSaveRequests = useRef<((success: boolean) => void)[]>([]);
  const latestCapture = useRef(capture);
  latestCapture.current = capture;
  const controlRevision = useCallback(
    () =>
      contentFingerprint(
        JSON.stringify({
          view: latestCapture.current(),
          savedRevision: tab.trackView?.revision ?? null,
          path: tab.trackView?.path ?? null,
          workspaceRoot: tab.trackView?.workspaceRoot ?? null,
        })
      ),
    [tab.trackView?.revision]
  );
  useCommandHandler(
    COMMAND_IDS.editUndo,
    () => useLaneContractStore.getState().undoLaneChange(tab.id),
    {
      scope: COMMAND_SCOPES.tabSequence,
      active: isActive,
      enabled: () => useLaneContractStore.getState().canUndoLaneChange(tab.id),
    }
  );
  useCommandHandler(
    COMMAND_IDS.editRedo,
    () => useLaneContractStore.getState().redoLaneChange(tab.id),
    {
      scope: COMMAND_SCOPES.tabSequence,
      active: isActive,
      enabled: () => useLaneContractStore.getState().canRedoLaneChange(tab.id),
    }
  );
  const completeRequestedSave = useCallback(
    ({
      success,
      requests = pendingSaveRequests.current.splice(0),
    }: {
      success: boolean;
      requests?: readonly ((success: boolean) => void)[];
    }) => {
      for (const complete of requests) complete(success);
    },
    []
  );
  const close = useCallback(
    (restoreFocus = true) => {
      if (busy.current) return;
      setSurface(null);
      setError(null);
      completeRequestedSave({ success: false });
      if (restoreFocus) safeFocus(trigger.current);
    },
    [completeRequestedSave]
  );
  const draftIsDirty = useCallback(() => {
    if (!readyForDirtyCheck) return false;
    if (!tab.trackView) return true;
    try {
      return !trackViewMatchesSavedConfiguration(latestCapture.current(), tab.trackView.document);
    } catch {
      return true;
    }
  }, [readyForDirtyCheck, tab.trackView, lanes]);
  const beginNaming = useCallback(
    (mode: 'save' | 'rename' | 'copy') => {
      const currentName = tab.trackView?.document.name ?? `${referenceName} view`;
      setName(mode === 'copy' ? `${currentName} copy` : currentName);
      setError(null);
      setSurface(mode);
    },
    [referenceName, tab.trackView?.document.name]
  );
  useEffect(() => {
    if (surface === 'menu')
      root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    else if (surface) {
      safeFocus(nameInput.current);
      nameInput.current?.select();
    }
  }, [surface]);
  useEffect(() => {
    if (surface !== 'menu' && surface !== 'rename') return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [surface, close]);
  const save = useCallback(
    async (
      nextName: string,
      copy = false,
      destination?: SaveTrackViewRequest['destination'],
      agent?: { mode: 'save' | 'rename' | 'copy'; expectedRevision: string }
    ) => {
      if (busy.current || !nextName.trim())
        return { ok: false as const, error: 'The view is busy or its name is empty.' };
      if (agent && surface !== null)
        return {
          ok: false as const,
          error: 'Finish or cancel the open view dialog before changing this view.',
        };
      if (agent && agent.expectedRevision !== controlRevision())
        return { ok: false as const, error: 'The view changed. Inspect it again before saving.' };
      const requests = pendingSaveRequests.current.splice(0);
      busy.current = true;
      setSaving(true);
      setError(null);
      try {
        const previous = copy ? null : tab.trackView;
        const renaming = (agent?.mode ?? surface) === 'rename' && previous;
        const now = new Date().toISOString();
        const portableReference = renaming
          ? previous.document.portableReference
          : await capturePortableReference?.();
        const document = validateTrackViewDocument({
          ...(renaming ? previous.document : capture()),
          ...(portableReference ? { portableReference } : {}),
          schema: 'dnaforge.track-view.v3',
          kind: 'track-view',
          id:
            previous?.document.id ??
            (!copy && trackViewIdSchema.safeParse(tab.entityId).success
              ? tab.entityId
              : `track-view-${crypto.randomUUID()}`),
          name: nextName.trim(),
          createdAt: previous?.document.createdAt ?? now,
          ...(previous?.document.creationRequest
            ? { creationRequest: previous.document.creationRequest }
            : {}),
          updatedAt: now,
        });
        if (portableReference) await trackViewRecoveryDocument(document);
        if (agent && agent.expectedRevision !== controlRevision())
          throw new Error('The view changed while preparing its save. Inspect it again.');
        const result = await saveTrackView({
          expectedRevision: previous?.revision ?? null,
          ...(destination
            ? { destination }
            : previous
              ? {
                  destination: {
                    path: previous.path,
                    workspaceRoot:
                      previous.workspaceRoot ?? previous.path.replace(/[\\/][^\\/]+$/, ''),
                  },
                }
              : {}),
          document,
        });
        const unchanged =
          renaming ||
          trackViewMatchesSavedConfiguration(latestCapture.current(), result.saved.document);
        if (copy) {
          await openTrackView(result.saved.document.id);
        } else {
          for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
            if (panel.tabs.some((candidate) => candidate.id === tab.id)) {
              const document = result.saved.document;
              useCanvasStore.getState().updateTab(panelId, tab.id, {
                entityId: result.saved.document.id,
                label: result.saved.document.name,
                trackView: result.saved,
                sequenceDocument: {
                  kind: 'indexed-sequence',
                  documentId: result.saved.document.id,
                },
                ...(!renaming && unchanged
                  ? {
                      initialAnnotationMapperPolicy: document.annotation.policy,
                      viewState: {
                        ...tab.viewState,
                        indexedViewport: document.viewport,
                        indexedGenomeViewRestoreCommand: {
                          id: previous
                            ? (tab.viewState?.indexedGenomeViewRestoreCommand?.id ??
                              crypto.randomUUID())
                            : crypto.randomUUID(),
                          viewport: { kind: 'assembly-range' as const, ...document.viewport },
                          annotationPolicy: document.annotation.policy,
                          orderedAnnotationTrackIds: document.annotation.orderedTrackIds,
                          visibleAnnotationTrackIds: Object.entries(
                            document.annotation.visibilityByTrackId
                          )
                            .filter(([, visible]) => visible)
                            .map(([id]) => id),
                        },
                      },
                      ...(!previous
                        ? {
                            indexedGenome: tab.indexedGenome
                              ? {
                                  ...tab.indexedGenome,
                                  scope: document.scope,
                                  dataTracks: document.dataTracks,
                                  bamTracks: document.bamTracks,
                                  signalReadPileupViews: document.signalReadPileupViews,
                                  variantSource: document.variantSource,
                                }
                              : undefined,
                          }
                        : {}),
                    }
                  : {}),
              });
              break;
            }
          }
        }
        setSurface(null);
        useToastStore
          .getState()
          .addToast(
            result.warning != null
              ? toUserMessage(result.warning, 'operation.failed')
              : userMessage('notice.view-saved'),
            {
              definition: 'track-view-result',
              variant: result.warning ? 'warning' : 'success',
            }
          );
        if (!copy && !agent) safeFocus(trigger.current);
        completeRequestedSave({ success: Boolean(unchanged), requests });
        return {
          ok: true as const,
          saved: result.saved,
          dirty: copy ? false : renaming ? draftIsDirty() : !unchanged,
          warning: result.warning,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not save this Track view.';
        setError(toUserMessage(message, 'tracks.loadFailed'));
        useToastStore.getState().addToast(toUserMessage(message, 'tracks.loadFailed'), {
          definition: 'track-view-failed',
        });

        if (surface === 'save') pendingSaveRequests.current.unshift(...requests);
        else completeRequestedSave({ success: false, requests });
        return { ok: false as const, error: toUserMessage(message, 'tracks.loadFailed') };
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [capture, capturePortableReference, tab, surface, completeRequestedSave, controlRevision]
  );
  useEffect(() => {
    if (!readyForDirtyCheck) return;
    return registerTrackViewControl(tab.id, {
      inspect: () => ({
        revision: controlRevision(),
        document: {
          ...latestCapture.current(),
          name: tab.trackView?.document.name ?? referenceName,
        },
        savedRevision: tab.trackView?.revision ?? null,
        path: tab.trackView?.path ?? null,
        workspaceRoot: tab.trackView?.workspaceRoot ?? null,
        dirty: draftIsDirty(),
      }),
      save: (request) => save(request.name, request.mode === 'copy', request.destination, request),
    });
  }, [tab, referenceName, readyForDirtyCheck, controlRevision, save]);
  useDocumentLifecycle({
    target: { kind: 'tab', tabId: tab.id },
    tabId: tab.id,
    isDirty: draftIsDirty,
    save: () =>
      new Promise<boolean>((resolve) => {
        if (busy.current) {
          resolve(false);
          return;
        }
        pendingSaveRequests.current.push(resolve);
        if (surface === 'rename') void save(name);
        else if (tab.trackView) void save(tab.trackView.document.name);
        else beginNaming('save');
      }),
    discard: () => completeRequestedSave({ success: false }),
  });
  useEffect(() => () => completeRequestedSave({ success: false }), [completeRequestedSave]);
  return (
    <div
      ref={root}
      className="relative flex items-center gap-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (
          surface === 'menu' &&
          ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          const items = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
          );
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
      onBlur={(event) => {
        if (
          (surface === 'menu' || surface === 'rename') &&
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          close(false);
      }}
    >
      <button
        type="button"
        className="h-8 rounded border border-border px-3 text-sm hover:bg-bg-muted disabled:cursor-wait disabled:opacity-50"
        disabled={saving}
        onClick={() => {
          if (tab.trackView) void save(tab.trackView.document.name);
          else beginNaming('save');
        }}
      >
        {saving && surface === null ? 'Saving…' : 'Save view'}
      </button>
      <IconButton
        ref={trigger}
        icon={<EllipsisIcon className="h-5 w-5 text-fg" strokeWidth={3} />}
        label="Track view actions"
        size="sm"
        variant="ghost"
        showTooltip={false}
        disabled={saving}
        aria-haspopup="menu"
        aria-expanded={surface === 'menu'}
        onClick={() => {
          if (surface) close();
          else setSurface('menu');
        }}
      />
      {surface === 'menu' && (
        <PresentationScopeContext.Provider value={presentationOverlay.scope}>
          <div
            role="menu"
            aria-label="Track view actions"
            className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-border bg-bg p-1 shadow-lg"
            ref={presentationOverlay.bindRef(undefined, '0')}
          >
            {tab.trackView && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full rounded px-3 py-2 text-left text-sm text-fg hover:bg-bg-muted focus:bg-bg-muted"
                  onClick={() => beginNaming('rename')}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full rounded px-3 py-2 text-left text-sm text-fg hover:bg-bg-muted focus:bg-bg-muted"
                  onClick={() => beginNaming('copy')}
                >
                  Save As…
                </button>
              </>
            )}
          </div>
        </PresentationScopeContext.Provider>
      )}
      {(surface === 'save' || surface === 'copy') && (
        <TrackViewSaveDialog
          initialName={name}
          initialPath={tab.trackView?.path}
          saving={saving}
          error={error}
          onCancel={() => close()}
          onSave={(nextName, destination) => void save(nextName, surface === 'copy', destination)}
        />
      )}
      {surface === 'rename' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(name);
          }}
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-bg p-3 shadow-lg"
          aria-label="Rename Track view"
        >
          <label className="mb-2 block text-xs text-fg-muted" htmlFor={`track-view-name-${tab.id}`}>
            Rename Track view
          </label>
          <TextField
            ref={nameInput}
            id={`track-view-name-${tab.id}`}
            aria-label="Track view name"
            value={name}
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" disabled={saving} onClick={() => close()}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : surface === 'rename' ? 'Rename' : 'Save Track view'}
            </Button>
          </div>
          {error && (
            <span role="alert" className="mt-2 block text-xs text-red-600">
              {toUserMessage(error, 'tracks.loadFailed')}
            </span>
          )}
        </form>
      )}
    </div>
  );
}
