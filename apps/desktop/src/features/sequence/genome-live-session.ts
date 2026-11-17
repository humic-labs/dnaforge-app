import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { platform } from '../../platform';
import type {
  GenomeOpenSource,
  GenomeSessionShell,
  GenomeSessionUpdate,
  GenomeTrackDescriptor,
  IndexedGenomeTabState,
} from '../../shared/indexed-genome';
import { markGenomeSessionTrackError } from '../../shared/genome-session-shell';
import { withoutSessionReadinessDemotion } from '../../shared/genome-session-readiness';
import { isIndexedSourceUnavailable } from '../../shared/platform-indexed-genome-data-source';
import {
  beginIndexedGenomeOpen,
  claimIndexedGenomeOpen,
  type IndexedGenomeOpenTelemetry,
} from './indexed-genome-lifecycle-telemetry';

type Preparation =
  | { status: 'pending'; phase: 'indexing' | 'opening' }
  | { status: 'ready' }
  | { status: 'degraded'; message: UserMessage }
  | { status: 'failed'; message: UserMessage };

type Presentation =
  | { status: 'awaiting' }
  | { status: 'failed'; message: UserMessage | null }
  | { status: 'presented'; phase: 'loading' | 'ready' | 'error'; message: UserMessage | null };

export interface GenomeLiveSessionSnapshot {
  generation: number;
  ownerKey: string | null;
  opening: 'fresh' | 'retained';
  preparation: Preparation;
  presentation: Presentation;
  shell: GenomeSessionShell | null;
  capabilityError: UserMessage | null;
}

interface OpenInput {
  tabId: string;
  ownerKey: string;
  hasManifest: boolean;
  retainPresentation: boolean;
  restorationSource: Pick<
    IndexedGenomeTabState,
    'sourcePath' | 'sourceExt' | 'sourceSizeBytes' | 'sourceMtimeMs' | 'sourceCtimeMs' | 'chrom'
  >;
  prepareSource(): Promise<GenomeOpenSource>;
  projectReadyState(state: IndexedGenomeTabState): IndexedGenomeTabState;
  persist(
    state: IndexedGenomeTabState,
    status: 'indexed' | 'indexed-pending' | 'indexed-error'
  ): void;
}

interface OpenAttempt {
  input: OpenInput;
  operation: IndexedGenomeOpenTelemetry;
  sessionId: string | null;
  earlyUpdates: Map<string, GenomeSessionUpdate>;
  poll: ReturnType<typeof setInterval> | null;
  polling: boolean;
  unsubscribe: (() => void) | null;
  fingerprint: string | null;
  requestedUpgrade: string | null;
  upgradeTail: Promise<void>;
  expectedGeneration: GenomeSessionShell['assemblyAssetGeneration'];
  trackErrors: Map<GenomeTrackDescriptor['kind'], string>;
}

export class GenomeLiveSession {
  private snapshot: GenomeLiveSessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private attempt: OpenAttempt | null = null;

  constructor(hasManifest: boolean) {
    this.snapshot = {
      generation: 0,
      ownerKey: null,
      opening: 'fresh',
      preparation: { status: 'pending', phase: hasManifest ? 'opening' : 'indexing' },
      presentation: { status: 'awaiting' },
      shell: null,
      capabilityError: null,
    };
  }

  readonly getSnapshot = (): GenomeLiveSessionSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<GenomeLiveSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  open(input: OpenInput): (reason: 'closed' | 'superseded') => void {
    this.close('superseded');
    const previous = this.snapshot;
    const retain =
      input.retainPresentation &&
      previous.ownerKey === input.ownerKey &&
      previous.presentation.status === 'presented';
    const attempt: OpenAttempt = {
      input,
      operation:
        claimIndexedGenomeOpen(input.tabId) ??
        beginIndexedGenomeOpen(
          !previous.ownerKey
            ? 'restored'
            : previous.ownerKey === input.ownerKey
              ? 'retry'
              : 'source_switch'
        ),
      sessionId: null,
      earlyUpdates: new Map(),
      poll: null,
      polling: false,
      unsubscribe: null,
      fingerprint: null,
      requestedUpgrade: null,
      upgradeTail: Promise.resolve(),
      expectedGeneration: undefined,
      trackErrors: new Map(),
    };
    this.attempt = attempt;
    this.publish({
      generation: previous.generation + 1,
      ownerKey: input.ownerKey,
      opening: retain ? 'retained' : 'fresh',
      preparation: { status: 'pending', phase: input.hasManifest ? 'opening' : 'indexing' },
      presentation: retain ? previous.presentation : { status: 'awaiting' },
      shell: null,
      capabilityError: null,
    });
    void this.openNative(attempt);
    return (reason) => {
      if (this.attempt === attempt) this.close(reason);
    };
  }

  refuse(tabId: string, message: UserMessage): void {
    this.close('superseded');
    claimIndexedGenomeOpen(tabId)?.end({ outcome: 'refused', reason: 'source_unavailable' });
    this.publish({
      generation: this.snapshot.generation + 1,
      opening: 'fresh',
      shell: null,
      presentation: { status: 'awaiting' },
      preparation: { status: 'failed', message },
    });
  }

  showIdeogram(ownerKey: string): void {
    this.close('superseded');
    this.publish({
      generation: this.snapshot.generation + 1,
      ownerKey,
      opening: 'fresh',
      preparation: { status: 'ready' },
      presentation: { status: 'awaiting' },
      shell: null,
      capabilityError: null,
    });
  }

  private async openNative(attempt: OpenAttempt): Promise<void> {
    try {
      const source = await attempt.input.prepareSource();
      if (this.attempt !== attempt) return;
      attempt.expectedGeneration =
        'assetGeneration' in source.intent ? source.intent.assetGeneration : undefined;
      attempt.unsubscribe = platform().on('genome:sessionUpdated', (payload) => {
        const update = payload as GenomeSessionUpdate;
        if (this.attempt !== attempt || update.sessionId !== update.shell.sessionId) return;
        if (attempt.sessionId === null) {
          if (update.shell.sourcePath === source.sourcePath) {
            const previous = attempt.earlyUpdates.get(update.sessionId);
            if (
              update.prepareStatus !== 'preparing' ||
              !previous ||
              previous.prepareStatus === 'preparing'
            )
              attempt.earlyUpdates.set(update.sessionId, update);
          }
          return;
        }
        this.acceptUpdate(attempt, update);
      });
      const shell = await platform().genome.open(source);
      if (this.attempt !== attempt) {
        await platform()
          .genome.closeSession(shell.sessionId)
          .catch(() => false);
        return;
      }
      attempt.sessionId = shell.sessionId;
      if (shell.coordinateReady) attempt.operation.coordinateReady();
      this.publish({ shell });
      const early = attempt.earlyUpdates.get(shell.sessionId);
      attempt.earlyUpdates.clear();
      if (early) this.acceptUpdate(attempt, early);
      if (this.snapshot.preparation.status === 'pending') {
        void this.recover(attempt);
        attempt.poll = setInterval(() => void this.recover(attempt), 750);
      }
    } catch (error) {
      if (this.attempt !== attempt) return;
      attempt.operation.end(
        isIndexedSourceUnavailable(error)
          ? { outcome: 'refused', reason: 'source_unavailable' }
          : { outcome: 'failed', reason: 'session' }
      );
      const message = toUserMessage(error, 'tracks.loadFailed');
      attempt.input.persist(
        { ...attempt.input.restorationSource, error: message },
        'indexed-error'
      );
      this.stopPoll(attempt);
      this.publish({ preparation: { status: 'failed', message } });
    }
  }

  private async recover(attempt: OpenAttempt): Promise<void> {
    if (
      this.attempt !== attempt ||
      attempt.polling ||
      !attempt.sessionId ||
      this.snapshot.preparation.status !== 'pending'
    )
      return;
    attempt.polling = true;
    try {
      const shell = await platform().genome.getSession(attempt.sessionId);
      if (this.attempt !== attempt || this.snapshot.preparation.status !== 'pending') return;
      const tabState = readyStateFromShell(shell, attempt.input.restorationSource);
      this.acceptUpdate(attempt, {
        sessionId: shell.sessionId,
        shell,
        prepareLoadPhase:
          tabState || this.snapshot.preparation.status !== 'pending'
            ? 'opening'
            : this.snapshot.preparation.phase,
        prepareStatus:
          shell.preparationError !== undefined ? 'error' : tabState ? 'ready' : 'preparing',
        ...(shell.preparationError !== undefined
          ? {
              error: shell.preparationError,
              tabState: { ...attempt.input.restorationSource, error: shell.preparationError },
            }
          : tabState
            ? { tabState }
            : {}),
      });
    } catch {
    } finally {
      attempt.polling = false;
    }
  }

  private acceptUpdate(attempt: OpenAttempt, update: GenomeSessionUpdate): void {
    if (this.attempt !== attempt || update.sessionId !== attempt.sessionId) return;
    if (update.prepareStatus === 'preparing' && this.snapshot.preparation.status !== 'pending')
      return;
    const incomingGeneration = update.shell.assemblyAssetGeneration;
    if (
      attempt.expectedGeneration &&
      incomingGeneration &&
      generationKey(attempt.expectedGeneration) !== generationKey(incomingGeneration)
    )
      return;
    const fingerprint = JSON.stringify(update);
    if (attempt.fingerprint === fingerprint) return;
    attempt.fingerprint = fingerprint;
    if (update.shell.coordinateReady) attempt.operation.coordinateReady();
    if (
      incomingGeneration &&
      this.snapshot.shell?.assemblyAssetGeneration &&
      generationKey(incomingGeneration) !==
        generationKey(this.snapshot.shell.assemblyAssetGeneration)
    )
      attempt.trackErrors.clear();
    let shell = withoutSessionReadinessDemotion(this.snapshot.shell, update.shell);
    for (const [kind, message] of attempt.trackErrors)
      shell = markGenomeSessionTrackError({ session: shell, kind, message });
    if (update.prepareStatus === 'error') {
      this.stopPoll(attempt);
      if (update.tabState) attempt.input.persist(update.tabState, 'indexed-error');
      const detail = update.error ?? update.tabState?.error ?? 'Failed to index genome';
      const message = toUserMessage(detail, 'tracks.loadFailed');
      if (this.snapshot.presentation.status === 'presented') {
        attempt.trackErrors.set('sequence', detail);
        this.publish({
          shell: markGenomeSessionTrackError({ session: shell, kind: 'sequence', message: detail }),
          preparation: { status: 'degraded', message },
        });
      } else {
        attempt.operation.end({ outcome: 'failed', reason: 'index' });
        this.publish({ shell, preparation: { status: 'failed', message } });
      }
      return;
    }
    if (update.tabState)
      attempt.input.persist(
        update.prepareStatus === 'ready'
          ? attempt.input.projectReadyState(update.tabState)
          : update.tabState,
        update.prepareStatus === 'ready' || update.tabState.manifest ? 'indexed' : 'indexed-pending'
      );
    if (update.prepareStatus === 'ready') this.stopPoll(attempt);
    this.publish({
      shell,
      preparation:
        update.prepareStatus === 'ready'
          ? { status: 'ready' }
          : { status: 'pending', phase: update.prepareLoadPhase },
    });
  }

  requestCapabilities(source: GenomeOpenSource): void {
    const attempt = this.attempt;
    const shell = this.snapshot.shell;
    if (!attempt?.sessionId || !shell?.openReady || source.intent.kind !== 'reference-assembly')
      return;
    const intent = source.intent;
    const requestedSearch = intent.searchReadiness;
    if (
      shell.assemblyAnnotationProductsReadiness === 'ready' &&
      (requestedSearch !== 'ready' || shell.assemblySearchReadiness === 'ready') &&
      generationKey(shell.assemblyAssetGeneration) === generationKey(intent.assetGeneration)
    )
      return;
    const requestKey = `${attempt.sessionId}:${generationKey(intent.assetGeneration)}:${requestedSearch}`;
    if (attempt.requestedUpgrade === requestKey) return;
    attempt.requestedUpgrade = requestKey;
    attempt.expectedGeneration = intent.assetGeneration;
    const sessionId = attempt.sessionId;
    const queued = attempt.upgradeTail
      .catch(() => undefined)
      .then(async () => {
        if (this.attempt !== attempt || attempt.requestedUpgrade !== requestKey) return;
        const upgraded = await platform().genome.upgradeSessionCapabilities(sessionId, source);
        if (
          this.attempt !== attempt ||
          attempt.requestedUpgrade !== requestKey ||
          upgraded.sessionId !== sessionId
        )
          return;
        this.acceptUpdate(attempt, {
          sessionId,
          shell: upgraded,
          prepareStatus: 'ready',
          prepareLoadPhase: 'opening',
        });
        this.publish({ capabilityError: null });
      })
      .catch((error) => {
        if (this.attempt !== attempt || attempt.requestedUpgrade !== requestKey) return;
        attempt.requestedUpgrade = null;
        attempt.expectedGeneration = this.snapshot.shell?.assemblyAssetGeneration;
        this.publish({
          capabilityError: toUserMessage(
            error,
            'failure.prepared-genome-capabilities-could-not-be-admitted'
          ),
        });
      });
    attempt.upgradeTail = queued;
  }

  viewerPhase(generation: number, phase: 'loading' | 'ready' | 'error', message?: string): void {
    if (generation !== this.snapshot.generation || !this.snapshot.ownerKey) return;
    const error =
      phase === 'error' && message != null ? toUserMessage(message, 'tracks.loadFailed') : null;
    if (phase === 'error') this.attempt?.operation.end({ outcome: 'failed', reason: 'renderer' });
    const presentation: Presentation =
      phase === 'ready' || this.snapshot.presentation.status === 'presented'
        ? { status: 'presented', phase, message: error }
        : phase === 'error'
          ? { status: 'failed', message: error }
          : { status: 'awaiting' };
    if (JSON.stringify(presentation) !== JSON.stringify(this.snapshot.presentation))
      this.publish({ presentation });
  }

  trackError(generation: number, kind: GenomeTrackDescriptor['kind'], message: string): void {
    if (generation !== this.snapshot.generation || !this.snapshot.shell) return;
    this.attempt?.trackErrors.set(kind, message);
    this.publish({
      shell: markGenomeSessionTrackError({ session: this.snapshot.shell, kind, message }),
    });
  }

  viewportPresented(sessionId: string, commandId: number | null): void {
    if (this.attempt?.sessionId !== sessionId) return;
    if (commandId === null) this.attempt.operation.firstViewportPresented();
    else this.attempt.operation.viewportPresented(commandId);
  }

  acceptViewport(commandId: number): void {
    this.attempt?.operation.acceptViewport(commandId);
  }
  refuseViewport(): void {
    this.attempt?.operation.refuseViewport();
  }

  private stopPoll(attempt: OpenAttempt): void {
    if (attempt.poll !== null) clearInterval(attempt.poll);
    attempt.poll = null;
  }

  private close(reason: 'closed' | 'superseded'): void {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    attempt.operation.end(
      reason === 'closed' ? { outcome: 'cancelled', reason } : { outcome: 'superseded', reason }
    );
    this.stopPoll(attempt);
    attempt.unsubscribe?.();
    attempt.earlyUpdates.clear();
    if (reason === 'closed')
      this.publish({
        generation: this.snapshot.generation + 1,
        ownerKey: null,
        shell: null,
        presentation: { status: 'awaiting' },
        preparation: { status: 'pending', phase: 'opening' },
      });
    if (attempt.sessionId)
      void platform()
        .genome.closeSession(attempt.sessionId)
        .catch(() => false);
  }
}

export function genomeLiveSessionView(snapshot: GenomeLiveSessionSnapshot) {
  const { preparation, presentation } = snapshot;
  return {
    sessionShell: snapshot.shell,
    prepareStatus:
      preparation.status === 'failed'
        ? ('error' as const)
        : preparation.status === 'pending' && snapshot.opening !== 'retained'
          ? ('preparing' as const)
          : ('ready' as const),
    prepareLoadPhase: preparation.status === 'pending' ? preparation.phase : ('opening' as const),
    prepareError: preparation.status === 'failed' ? preparation.message : null,
    viewerLoadPhase:
      presentation.status === 'awaiting'
        ? ('loading' as const)
        : presentation.status === 'failed'
          ? ('error' as const)
          : presentation.phase,
    viewerLoadError: presentation.status === 'awaiting' ? null : presentation.message,
  };
}

function generationKey(generation: GenomeSessionShell['assemblyAssetGeneration']): string {
  return `${generation?.sourceFingerprint ?? ''}:${generation?.inventoryFingerprint ?? ''}`;
}

function readyStateFromShell(
  shell: GenomeSessionShell,
  source: OpenInput['restorationSource']
): IndexedGenomeTabState | null {
  if (
    !shell.openReady ||
    shell.validationState !== 'strong_match' ||
    !shell.coordinateReady ||
    !shell.manifest ||
    typeof shell.length !== 'number'
  )
    return null;
  return {
    ...source,
    sourcePath: shell.sourcePath,
    sourceSizeBytes: shell.sourceSizeBytes,
    chrom: shell.chrom,
    manifest: { ...shell.manifest, length: shell.length },
    metadata: { length: shell.length, circular: shell.manifest.circular ?? false },
    indexedAt: Date.now(),
  };
}
