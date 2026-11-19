import type { PortableGenomeViewReference } from '@waypoint/genome-data';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { contentFingerprint } from '../../db/entity-substrate/adapter';
import { reportSaveFailure } from '../../lib/report-save-failure';
import { documentLifecycle, type DocumentSaveScope } from '../../shared/document-lifecycle';
import {
  trackViewIdSchema,
  validateTrackViewDocument,
  type SaveTrackViewRequest,
  type SavedTrackView,
} from '../../shared/track-view';
import { useToastStore } from '../../stores/toast-store';
import type { Tab } from '../canvas/public/types';
import { useCanvasStore } from '../canvas/public/store';
import { trackViewMatchesSavedConfiguration } from './track-view-configuration';
import type { TrackViewControl, TrackViewSnapshot } from './track-view-control';
import { saveTrackView } from './track-view-library';
import { trackViewUserLayers } from './indexed-user-annotations';
import {
  sameSavedReference,
  trackViewRecoveryDocument,
  trackViewSourceBindings,
} from './track-view-recovery-document';

type Mode = 'save' | 'rename' | 'copy';
type Naming = { kind: 'naming'; mode: Mode; name: string; error: string | null };
export type TrackViewInteraction =
  | { kind: 'idle' }
  | Naming
  | { kind: 'saving'; mode: Mode; naming: Naming | null }
  | { kind: 'closed' };
export interface TrackViewSource {
  referenceName: string;
  readyForDirtyCheck: boolean;
  capture(): TrackViewSnapshot;
  capturePortableReference?: () => Promise<PortableGenomeViewReference>;
}

export class TrackViewSession implements TrackViewControl {
  private tab: Tab;
  private saved: SavedTrackView | undefined;
  private source: { token: symbol; value: TrackViewSource } | null = null;
  private snapshot: TrackViewSnapshot | null;
  private capturePortableReference?: TrackViewSource['capturePortableReference'];
  private ready = false;
  private interaction: TrackViewInteraction = { kind: 'idle' };
  private readonly listeners = new Set<() => void>();
  private readonly pendingSaves = new Set<(saved: boolean) => void>();
  private readonly registration: ReturnType<typeof documentLifecycle.register>;

  constructor(tab: Tab) {
    this.tab = tab;
    this.saved = tab.trackView;
    this.snapshot = tab.trackView?.document ?? null;
    this.registration = documentLifecycle.register({
      target: { kind: 'tab', tabId: tab.id },
      tabId: tab.id,
      isDirty: this.isDirty,
      save: this.requestSave,
      discard: () => this.cancelNaming(),
    });
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.interaction;
  private closed() {
    return this.interaction.kind === 'closed';
  }
  private transition(next: TrackViewInteraction) {
    this.interaction = next;
    for (const listener of this.listeners) listener();
    this.registration.changed();
  }
  ownsTab(tab: Tab) {
    return tab.entityId === this.tab.entityId || tab.entityId === this.saved?.document.id;
  }
  receiveTab(tab: Tab) {
    this.tab = tab;
    if (this.saved !== tab.trackView) {
      this.saved = tab.trackView;
      this.ready = false;
      this.source = null;
      this.capturePortableReference = undefined;
      this.snapshot = this.saved?.document ?? this.snapshot;
      this.registration.changed();
    }
  }
  attachSource(token: symbol, source: TrackViewSource) {
    if (this.closed()) return;
    this.source = { token, value: source };
    this.capturePortableReference = source.capturePortableReference;
    this.ready = source.readyForDirtyCheck;
    if (this.ready) this.snapshot = source.capture();
    this.registration.changed();
  }
  detachSource(token: symbol) {
    if (this.source?.token !== token) return;
    if (this.ready) {
      try {
        this.snapshot = this.source.value.capture();
      } catch {
        this.ready = false;
      }
    }
    this.source = null;
  }
  private restoredDraft() {
    const saved = this.saved?.document;
    const state = this.tab.indexedGenome;
    const view = this.tab.viewState;
    const viewport = view?.indexedViewport;
    if (
      !this.tab.isDirty ||
      !saved ||
      this.tab.entityId !== saved.id ||
      !state ||
      !viewport ||
      state.assembly?.assemblyId !== saved.reference.assemblyId ||
      view?.indexedViewportCommand
    )
      return null;
    const command = view.indexedGenomeViewRestoreCommand;
    const annotation =
      view.indexedAnnotationDraft?.id === command?.id
        ? (view.indexedAnnotationDraft ?? command)
        : command;
    const visible = new Set(annotation?.visibleAnnotationTrackIds);
    const userLayers = trackViewUserLayers(state);
    return {
      ...saved,
      viewport,
      scope: state.scope ?? saved.scope,
      annotation: annotation
        ? {
            policy: annotation.annotationPolicy,
            orderedTrackIds: annotation.orderedAnnotationTrackIds,
            visibilityByTrackId: Object.fromEntries(
              annotation.orderedAnnotationTrackIds.map((id) => [id, visible.has(id)])
            ),
          }
        : saved.annotation,
      dataTracks: state.dataTracks ?? state.ucscTracks ?? saved.dataTracks,
      bamTracks: state.bamTracks ?? saved.bamTracks,
      signalReadPileupViews: state.signalReadPileupViews ?? saved.signalReadPileupViews,
      sequenceDataLayers: Object.hasOwn(state, 'sequenceDataLayers')
        ? state.sequenceDataLayers
        : saved.sequenceDataLayers,
      comparisonProjection: Object.hasOwn(state, 'comparisonProjection')
        ? state.comparisonProjection
        : saved.comparisonProjection,
      contactProjection: Object.hasOwn(state, 'contactProjection')
        ? state.contactProjection
        : saved.contactProjection,
      variantSource: Object.hasOwn(state, 'variantSource')
        ? state.variantSource
        : saved.variantSource,
      primerBindings:
        state.primerBindings === undefined ? saved.primerBindings : userLayers.primerBindings,
      userAnnotations:
        state.userAnnotations === undefined ? saved.userAnnotations : userLayers.userAnnotations,
    };
  }
  private current(): TrackViewSnapshot {
    if (this.ready && this.source) this.snapshot = this.source.value.capture();
    if (!this.ready) this.snapshot = this.restoredDraft() ?? this.snapshot;
    if (!this.snapshot) throw new Error('The reference is still opening.');
    return this.snapshot;
  }
  readonly isDirty = (): boolean => {
    if (!this.ready) return Boolean(this.tab.isDirty);
    if (!this.saved) return true;
    try {
      return !trackViewMatchesSavedConfiguration(this.current(), this.saved.document);
    } catch {
      return true;
    }
  };
  private revision() {
    return contentFingerprint(
      JSON.stringify({
        view: this.current(),
        savedRevision: this.saved?.revision ?? null,
        path: this.saved?.path ?? null,
        workspaceRoot: this.saved?.workspaceRoot ?? null,
      })
    );
  }
  inspect() {
    if (this.closed()) throw new Error('This Track view is closed.');
    return {
      revision: this.revision(),
      document: {
        ...this.current(),
        name: this.saved?.document.name ?? this.source?.value.referenceName ?? this.tab.label,
      },
      savedRevision: this.saved?.revision ?? null,
      path: this.saved?.path ?? null,
      workspaceRoot: this.saved?.workspaceRoot ?? null,
      dirty: this.isDirty(),
    };
  }
  private suggestedName() {
    const reference =
      this.source?.value.referenceName ?? this.snapshot?.reference.name ?? this.tab.label;
    return `${reference.trim().slice(0, 195)} view`.trim();
  }
  beginNaming(mode: Mode) {
    if (this.closed() || this.interaction.kind === 'saving') return;
    const name = this.saved?.document.name ?? this.suggestedName();
    this.transition({
      kind: 'naming',
      mode,
      name: mode === 'copy' ? `${name} copy` : name,
      error: null,
    });
  }
  setName(name: string) {
    if (this.interaction.kind === 'naming') this.transition({ ...this.interaction, name });
  }
  cancelNaming() {
    if (this.closed() || this.interaction.kind === 'saving') return;
    this.transition({ kind: 'idle' });
    this.settle(false);
  }
  private settle(success: boolean) {
    const pending = [...this.pendingSaves];
    this.pendingSaves.clear();
    for (const resolve of pending) resolve(success);
  }
  readonly requestSave = (scope: DocumentSaveScope = 'document'): Promise<boolean> => {
    if (this.closed()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pendingSaves.add(resolve);
      if (this.interaction.kind === 'saving') return;
      if (this.interaction.kind === 'naming') {
        if (this.interaction.mode === 'rename') void this.saveHuman(this.interaction.name);
      } else if (this.saved) void this.saveHuman(this.saved.document.name);
      else if (scope === 'all') void this.saveHuman(this.suggestedName());
      else this.beginNaming('save');
    });
  };
  save(request: Parameters<TrackViewControl['save']>[0]) {
    if (this.interaction.kind === 'naming')
      return Promise.resolve({
        ok: false as const,
        error: 'Finish or cancel the open view dialog before changing this view.',
      });
    return this.write(request.name, request.mode, request.destination, request.expectedRevision);
  }
  saveHuman(name: string, destination?: SaveTrackViewRequest['destination']) {
    return this.write(
      name,
      this.interaction.kind === 'naming' ? this.interaction.mode : 'save',
      destination
    );
  }
  private async write(
    name: string,
    mode: Mode,
    destination?: SaveTrackViewRequest['destination'],
    expectedRevision?: string
  ): ReturnType<TrackViewControl['save']> {
    if (this.closed() || this.interaction.kind === 'saving' || !name.trim())
      return { ok: false, error: 'The view is closed, busy or its name is empty.' };
    if (mode !== 'rename' && !this.ready && !this.restoredDraft()) {
      this.settle(false);
      return {
        ok: false,
        error: 'Wait for the reference to finish opening before saving its configuration.',
      };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision())
      return { ok: false, error: 'The view changed. Inspect it again before saving.' };
    const naming = this.interaction.kind === 'naming' ? this.interaction : null;
    this.transition({ kind: 'saving', mode, naming });
    try {
      const previous = mode === 'copy' ? null : this.saved;
      const renaming = mode === 'rename' && previous;
      const captured = renaming ? previous.document : this.current();
      const savedPresentation =
        mode === 'save' && expectedRevision === undefined ? previous?.document : undefined;
      const retainedReference =
        savedPresentation?.portableReference && sameSavedReference(captured, savedPresentation)
          ? savedPresentation.portableReference
          : undefined;
      const portableReference = renaming
        ? previous.document.portableReference
        : (retainedReference ??
          (this.ready ? await this.capturePortableReference?.() : undefined) ??
          captured.portableReference);
      const now = new Date().toISOString();
      const document = validateTrackViewDocument({
        ...captured,
        ...(portableReference ? { portableReference } : {}),
        schema: 'dnaforge.track-view.v3',
        kind: 'track-view',
        id:
          previous?.document.id ??
          (mode !== 'copy' && trackViewIdSchema.safeParse(this.tab.entityId).success
            ? this.tab.entityId
            : `track-view-${crypto.randomUUID()}`),
        name: name.trim(),
        createdAt: previous?.document.createdAt ?? now,
        ...(previous?.document.creationRequest
          ? { creationRequest: previous.document.creationRequest }
          : {}),
        updatedAt: now,
      });
      if (
        portableReference &&
        (!savedPresentation ||
          trackViewSourceBindings(savedPresentation) !== trackViewSourceBindings(document))
      )
        await trackViewRecoveryDocument(document);
      if (this.closed()) throw new Error('The Track view closed before its save began.');
      if (expectedRevision !== undefined && expectedRevision !== this.revision())
        throw new Error('The view changed while preparing its save. Inspect it again.');
      const result = await saveTrackView({
        expectedRevision: previous?.revision ?? null,
        ...(previous && mode === 'save' && expectedRevision === undefined
          ? { baseDocument: previous.document }
          : {}),
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
      if (this.closed()) return { ok: false, error: 'The file was saved after its tab closed.' };
      const unchanged =
        Boolean(renaming) || trackViewMatchesSavedConfiguration(this.current(), document);
      if (mode === 'copy') {
        const { openTrackView } = await import('./open-track-view');
        if (!this.closed()) await openTrackView(result.saved.document.id);
      } else if (!(result.saved.reconciliation === 'merged' && !unchanged)) {
        this.saved = result.saved;
        if (result.saved.reconciliation === 'merged' && unchanged) {
          this.source = null;
          this.snapshot = result.saved.document;
          this.ready = true;
        }
        this.projectSaved(result.saved, Boolean(renaming), unchanged, Boolean(previous));
      }
      if (this.closed()) return { ok: false, error: 'The Track view closed while saving.' };
      const dirty = mode !== 'copy' && (!unchanged || this.isDirty());
      this.transition({ kind: 'idle' });
      useToastStore
        .getState()
        .addToast(
          result.warning != null
            ? toUserMessage(result.warning, 'operation.failed')
            : result.saved.reconciliation === 'saved-copy'
              ? userMessage('notice.track-view-recovered-copy')
              : userMessage('notice.view-saved'),
          { definition: 'track-view-result', variant: result.warning ? 'warning' : 'success' }
        );
      this.settle(mode === 'copy' ? !this.isDirty() : !dirty);
      return { ok: true, saved: result.saved, dirty, warning: result.warning };
    } catch (error) {
      reportSaveFailure('[TrackViewSession] Save failed:', { tabId: this.tab.id }, error);
      const message = toUserMessage(
        error instanceof Error ? error.message : 'Could not save this Track view.',
        'document.saveFailed'
      );
      if (!this.closed()) {
        this.transition(naming ? { ...naming, error: message } : { kind: 'idle' });
        useToastStore.getState().addToast(message, { definition: 'track-view-failed' });
      }
      if (!naming || naming.mode !== 'save' || this.closed()) this.settle(false);
      return { ok: false, error: message };
    }
  }
  private projectSaved(
    saved: SavedTrackView,
    renaming: boolean,
    unchanged: boolean,
    previouslySaved: boolean
  ) {
    const tab = this.tab;
    for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
      if (!panel.tabs.some((candidate) => candidate.id === tab.id)) continue;
      const document = saved.document;
      useCanvasStore.getState().retargetTab(
        panelId,
        tab.id,
        {
          type: 'sequence',
          sequenceDocument: { kind: 'indexed-sequence', documentId: document.id },
        },
        {
          label: document.name,
          trackView: saved,
          ...(!renaming && unchanged
            ? {
                isDirty: false,
                initialAnnotationMapperPolicy: document.annotation.policy,
                viewState: {
                  ...tab.viewState,
                  indexedViewport: document.viewport,
                  indexedGenomeViewRestoreCommand: {
                    id:
                      previouslySaved && saved.reconciliation !== 'merged'
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
                ...(!previouslySaved || saved.reconciliation === 'merged'
                  ? {
                      indexedGenome: tab.indexedGenome
                        ? {
                            ...tab.indexedGenome,
                            scope: document.scope,
                            sequenceDataLayers: document.sequenceDataLayers,
                            contactProjection: document.contactProjection,
                            comparisonProjection: document.comparisonProjection,
                            primerBindings: document.primerBindings,
                            userAnnotations: document.userAnnotations,
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
        }
      );
      break;
    }
  }
  dispose() {
    if (this.closed()) return;
    this.source = null;
    this.interaction = { kind: 'closed' };
    this.registration.release();
    this.settle(false);
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}
