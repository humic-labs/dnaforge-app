import type { AnalyticsIdentitySyncResult } from '../shared/analytics-types';

export const PREIDENTITY_PUBLIC_CONTROL = 'f17-preidentity-public-control';
export const PREIDENTITY_SYNTHETIC_SENTINEL = 'DNAFORGE_PREIDENTITY_SYNTHETIC_SENTINEL';
const HOLD_LIFETIME_MS = 2_000;

export interface PreidentityProbe {
  ready: boolean;
  consentClass: 'off' | 'on' | 'draining';
  generation: number;
  pendingCount: number;
  pendingHead: number;
  publicControlCount: number;
  occurrenceClockRange: { first: number; last: number } | null;
  syntheticSentinelPresent: boolean;
}

export class PreidentityDiagnosticCancelled extends Error {
  constructor() {
    super('Preidentity diagnostic transition cancelled');
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export function createPreidentityDiagnostics(
  enabled: () => boolean,
  probe: (generation: number) => PreidentityProbe
) {
  let generation = 0;
  let used = false;
  let disposed = false;
  type Hold = {
    readonly armedAtMonotonicMs: number;
    readonly expiresAtMonotonicMs: number;
    generation: number | null;
    cancelled: boolean;
    expired: boolean;
    releaseStarted: boolean;
    releaseCompleted: boolean;
    timer: ReturnType<typeof setTimeout>;
    native: ReturnType<typeof deferred<AnalyticsIdentitySyncResult>>;
    released: ReturnType<typeof deferred<void>>;
  };
  let hold: Hold | null = null;
  const expire = (owned: Hold) => {
    if (owned.cancelled || owned.expired || owned.releaseCompleted) return;
    owned.expired = true;
    clearTimeout(owned.timer);
    owned.native.reject(new PreidentityDiagnosticCancelled());
    owned.released.resolve();
  };
  const reconcileElapsedExpiry = () => {
    if (
      hold &&
      !hold.cancelled &&
      !hold.expired &&
      !hold.releaseCompleted &&
      globalThis.performance.now() >= hold.expiresAtMonotonicMs
    )
      expire(hold);
  };
  const requireEnabled = () => {
    reconcileElapsedExpiry();
    if (!enabled() || disposed) throw new PreidentityDiagnosticCancelled();
  };
  const cancel = () => {
    reconcileElapsedExpiry();
    if (!hold || hold.cancelled) return;
    hold.cancelled = true;
    clearTimeout(hold.timer);
    hold.native.reject(new PreidentityDiagnosticCancelled());
    hold.released.reject(new PreidentityDiagnosticCancelled());
  };
  return {
    armNext(): void {
      requireEnabled();
      if (used) throw new PreidentityDiagnosticCancelled();
      used = true;
      const armedAtMonotonicMs = globalThis.performance.now();
      const native = deferred<AnalyticsIdentitySyncResult>();
      const released = deferred<void>();
      hold = {
        armedAtMonotonicMs,
        expiresAtMonotonicMs: armedAtMonotonicMs + HOLD_LIFETIME_MS,
        generation: null,
        cancelled: false,
        expired: false,
        releaseStarted: false,
        releaseCompleted: false,
        native,
        released,
        timer: setTimeout(() => {
          if (hold) expire(hold);
        }, HOLD_LIFETIME_MS),
      };
    },
    transitionStarted(next: number): void {
      reconcileElapsedExpiry();
      generation = next;
      if (!hold) return;
      if (hold.generation === null && !hold.cancelled) hold.generation = next;
      else if (hold.generation !== next) cancel();
    },
    publicationGate():
      | ((result: AnalyticsIdentitySyncResult) => Promise<AnalyticsIdentitySyncResult>)
      | null {
      reconcileElapsedExpiry();
      if (!enabled() || disposed || !hold || hold.generation !== generation) return null;
      const owned = hold;
      return async (result) => {
        reconcileElapsedExpiry();
        if (owned.cancelled || generation !== owned.generation)
          throw new PreidentityDiagnosticCancelled();
        owned.native.resolve(result);
        await owned.released.promise;
        requireEnabled();
        if (owned.cancelled || generation !== owned.generation)
          throw new PreidentityDiagnosticCancelled();
        return result;
      };
    },
    waitForNativeResult(): Promise<AnalyticsIdentitySyncResult> {
      requireEnabled();
      const owned = hold;
      if (!owned) throw new PreidentityDiagnosticCancelled();
      return owned.native.promise.then((result) => {
        requireEnabled();
        if (owned.cancelled || owned.expired || generation !== owned.generation)
          throw new PreidentityDiagnosticCancelled();
        return result;
      });
    },
    async release(): Promise<AnalyticsIdentitySyncResult> {
      requireEnabled();
      const owned = hold;
      if (!owned || owned.cancelled || owned.expired || owned.releaseStarted)
        throw new PreidentityDiagnosticCancelled();
      owned.releaseStarted = true;
      const result = await owned.native.promise;
      requireEnabled();
      if (owned.cancelled || owned.expired || generation !== owned.generation)
        throw new PreidentityDiagnosticCancelled();
      owned.releaseCompleted = true;
      clearTimeout(owned.timer);
      owned.released.resolve();
      return result;
    },
    read(): PreidentityProbe {
      requireEnabled();
      return probe(generation);
    },
    cancel,
    dispose(): void {
      cancel();
      disposed = true;
    },
  };
}
