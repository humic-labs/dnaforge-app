import { randomUUID } from 'node:crypto';

export interface GenomeSessionLifecycleStores<Session, Diagnostics> {
  sessions: Map<string, Session>;
  diagnostics: Map<string, Diagnostics>;
  owners: Map<string, number>;
  activeRequests: Map<string, AbortController>;
  preparations: Map<string, AbortController>;
}

export interface GenomeSessionCloseResult {
  sessionRemoved: boolean;
  activeSessionCount: number;
  requestsCancelled: number;
}

export const MAX_GENOME_SESSIONS_PER_RENDERER = 64;
export const MAX_ACTIVE_GENOME_SESSIONS = 256;

export const MAX_ACTIVE_GENOME_REQUESTS_PER_SESSION = 16;
export const MAX_ACTIVE_GENOME_REQUESTS = 256;

export function createGenomeSessionRequestId(
  kind: 'tile' | 'annotation-tile' | 'feature-details' | 'sequence-window'
): string {
  return `${kind}-${randomUUID()}`;
}

function activeRequestKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

export class GenomeSessionAdmission {
  private pending = 0;
  private readonly pendingByRenderer = new Map<number, number>();

  constructor(
    private readonly maxPerRenderer = MAX_GENOME_SESSIONS_PER_RENDERER,
    private readonly maxActive = MAX_ACTIVE_GENOME_SESSIONS
  ) {
    if (!Number.isInteger(maxPerRenderer) || maxPerRenderer < 1) {
      throw new Error('Genome session per-renderer capacity must be a positive integer.');
    }
    if (!Number.isInteger(maxActive) || maxActive < maxPerRenderer) {
      throw new Error('Genome session global capacity must cover one renderer.');
    }
  }

  begin<Session, Diagnostics>(
    stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
    rendererId: number
  ): () => void {
    if (stores.sessions.size + this.pending >= this.maxActive) {
      throw new Error('[genome] Active genome session capacity is full.');
    }

    let rendererSessions = this.pendingByRenderer.get(rendererId) ?? 0;
    for (const ownerId of stores.owners.values()) {
      if (ownerId === rendererId) rendererSessions += 1;
    }
    if (rendererSessions >= this.maxPerRenderer) {
      throw new Error('[genome] Renderer genome session capacity is full.');
    }

    this.pending += 1;
    this.pendingByRenderer.set(rendererId, (this.pendingByRenderer.get(rendererId) ?? 0) + 1);
    let owned = true;
    return () => {
      if (!owned) return;
      owned = false;
      this.pending -= 1;
      const rendererPending = this.pendingByRenderer.get(rendererId);
      if (rendererPending === undefined || rendererPending === 1) {
        this.pendingByRenderer.delete(rendererId);
      } else {
        this.pendingByRenderer.set(rendererId, rendererPending - 1);
      }
    };
  }
}

export function beginGenomeSessionRequest<Session, Diagnostics>(
  stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
  sessionId: string,
  requestId: string
): AbortController {
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new Error('[genome] Request id is required.');
  }
  const key = activeRequestKey(sessionId, requestId);
  if (stores.activeRequests.has(key)) {
    throw new Error(`[genome] Duplicate active request id: ${requestId}`);
  }
  if (stores.activeRequests.size >= MAX_ACTIVE_GENOME_REQUESTS) {
    throw new Error('[genome] Active genome request capacity is full.');
  }
  const requestPrefix = `${sessionId}:`;
  let sessionRequests = 0;
  for (const activeKey of stores.activeRequests.keys()) {
    if (activeKey.startsWith(requestPrefix)) sessionRequests += 1;
  }
  if (sessionRequests >= MAX_ACTIVE_GENOME_REQUESTS_PER_SESSION) {
    throw new Error('[genome] Genome session request capacity is full.');
  }
  const controller = new AbortController();
  stores.activeRequests.set(key, controller);
  return controller;
}

export function finishGenomeSessionRequest<Session, Diagnostics>(
  stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
  sessionId: string,
  requestId: string,
  controller: AbortController
): boolean {
  const key = activeRequestKey(sessionId, requestId);
  if (stores.activeRequests.get(key) !== controller) return false;
  return stores.activeRequests.delete(key);
}

export function bindGenomeSessionRequestToPhysicalLifecycle<Session, Diagnostics>(
  stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
  sessionId: string,
  requestId: string,
  controller: AbortController
): {
  readonly physicalLifecycle: Readonly<{ started(): void; settled(): void }>;
  readonly finishLogical: () => void;
} {
  let pendingPhysicalRequests = 0;
  let logicalFinished = false;
  let admissionReleased = false;
  const releaseWhenSettled = (): void => {
    if (admissionReleased || !logicalFinished || pendingPhysicalRequests !== 0) return;
    admissionReleased = true;
    finishGenomeSessionRequest(stores, sessionId, requestId, controller);
  };
  return {
    physicalLifecycle: {
      started(): void {
        if (logicalFinished) {
          throw new Error('[genome] Physical request started after its logical request finished.');
        }
        pendingPhysicalRequests += 1;
      },
      settled(): void {
        if (pendingPhysicalRequests < 1) {
          throw new Error('[genome] Physical request settled without a matching start.');
        }
        pendingPhysicalRequests -= 1;
        releaseWhenSettled();
      },
    },
    finishLogical(): void {
      logicalFinished = true;
      releaseWhenSettled();
    },
  };
}

export function cancelGenomeSessionRequest<Session, Diagnostics>(
  stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
  sessionId: string,
  requestId: string
): boolean {
  const key = activeRequestKey(sessionId, requestId);
  const controller = stores.activeRequests.get(key);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export function genomeSessionOwnedByRenderer<Session, Diagnostics>(
  stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
  sessionId: string,
  rendererId: number
): Session | null {
  if (stores.owners.get(sessionId) !== rendererId) return null;
  return stores.sessions.get(sessionId) ?? null;
}

export function closeGenomeSessionOwner<Session, Diagnostics>(
  stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
  sessionId: string
): GenomeSessionCloseResult {
  const sessionRemoved = stores.sessions.delete(sessionId);
  stores.diagnostics.delete(sessionId);
  stores.owners.delete(sessionId);
  const preparation = stores.preparations.get(sessionId);
  if (preparation) {
    preparation.abort();
    stores.preparations.delete(sessionId);
  }

  let requestsCancelled = 0;
  const requestPrefix = `${sessionId}:`;
  for (const [requestKey, controller] of stores.activeRequests) {
    if (!requestKey.startsWith(requestPrefix)) continue;
    if (controller.signal.aborted) continue;
    controller.abort();
    requestsCancelled += 1;
  }

  return { sessionRemoved, activeSessionCount: stores.sessions.size, requestsCancelled };
}

export function closeGenomeSessionsForRenderer<Session, Diagnostics>(
  stores: GenomeSessionLifecycleStores<Session, Diagnostics>,
  rendererId: number
): GenomeSessionCloseResult {
  let sessionRemoved = false;
  let requestsCancelled = 0;
  for (const [sessionId, ownerId] of [...stores.owners]) {
    if (ownerId !== rendererId) continue;
    const released = closeGenomeSessionOwner(stores, sessionId);
    sessionRemoved ||= released.sessionRemoved;
    requestsCancelled += released.requestsCancelled;
  }
  return { sessionRemoved, activeSessionCount: stores.sessions.size, requestsCancelled };
}

export function replaceGenomeSessionIfOwned<Session>(
  sessions: Map<string, Session>,
  sessionId: string,
  session: Session
): boolean {
  if (!sessions.has(sessionId)) return false;
  sessions.set(sessionId, session);
  return true;
}
