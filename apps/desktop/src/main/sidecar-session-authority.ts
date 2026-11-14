import { randomBytes, randomUUID } from 'node:crypto';
import { createProfileBoundNativeDocumentOwnerId } from './native-document-owner-identity';

export type SidecarSessionOwner = 'electron' | 'external';
export type SidecarSessionState =
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'stopped'
  | 'error'
  | 'timeout';
export type SidecarSpawnReason = 'initial' | 'respawn' | 'manual_restart';

export interface SidecarSessionSnapshot {
  readonly owner: SidecarSessionOwner;
  readonly generation: number;
  readonly state: SidecarSessionState;
  readonly token: string;
}

interface SidecarReadyWaiter {
  readonly resolve: (snapshot: SidecarSessionSnapshot) => void;
  readonly reject: (error: unknown) => void;
}

export class SidecarSessionUnavailableError extends Error {
  readonly code = 'SIDECAR_SESSION_UNAVAILABLE';

  constructor(state: SidecarSessionState) {
    super(
      `SIDECAR_SESSION_UNAVAILABLE: the compute service session is ${state}. ` +
        'Wait for it to become ready or restart the compute service, then retry.'
    );
    this.name = 'SidecarSessionUnavailableError';
  }
}

interface SidecarSessionAuthorityOptions {
  readonly initialToken?: string;
  readonly initialHumanOperationToken?: string;
  readonly initialNativeDocumentToken?: string;
  readonly initialNativeDocumentOwnerId?: string;
  readonly mintToken?: () => string;
}

function defaultMintToken(): string {
  return randomBytes(32).toString('base64url');
}

export class SidecarSessionAuthority {
  private readonly owner: SidecarSessionOwner;
  private readonly mintToken: () => string;
  private generation = 0;
  private state: SidecarSessionState = 'starting';
  private token: string;
  private humanToken: string | undefined;
  private nativeDocumentToken: string | undefined;
  private nativeDocumentOwnerId: string | undefined;
  private nativeDocumentProfile: string | undefined;
  private readonly readyWaiters = new Set<SidecarReadyWaiter>();
  private readonly subscribers = new Set<(snapshot: SidecarSessionSnapshot) => void>();

  constructor(options: SidecarSessionAuthorityOptions = {}) {
    const initialToken = options.initialToken?.trim();
    this.owner = initialToken ? 'external' : 'electron';
    this.mintToken = options.mintToken ?? defaultMintToken;
    this.token = initialToken || this.mintToken();
    this.humanToken = initialToken
      ? options.initialHumanOperationToken?.trim() || undefined
      : defaultMintToken();
    const nativeToken = options.initialNativeDocumentToken?.trim();
    const nativeOwnerId = options.initialNativeDocumentOwnerId?.trim();
    const validExternalNative =
      nativeToken && nativeOwnerId && nativeToken !== this.token && nativeToken !== this.humanToken;
    this.nativeDocumentToken = initialToken
      ? validExternalNative
        ? nativeToken
        : undefined
      : defaultMintToken();
    this.nativeDocumentOwnerId = initialToken
      ? validExternalNative
        ? nativeOwnerId
        : undefined
      : randomUUID();
  }

  snapshot(): SidecarSessionSnapshot {
    return {
      owner: this.owner,
      generation: this.generation,
      state: this.state,
      token: this.token,
    };
  }

  subscribe(listener: (snapshot: SidecarSessionSnapshot) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => this.subscribers.delete(listener);
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.subscribers) listener(snapshot);
  }

  bindNativeDocumentProfile(profileKey: string): void {
    if (this.generation !== 0 || this.state !== 'starting') {
      throw new Error('The native document owner has already started.');
    }
    if (this.owner === 'external') return;
    if (this.nativeDocumentProfile === profileKey) return;
    if (this.nativeDocumentProfile)
      throw new Error('The native document profile is already bound.');
    this.nativeDocumentOwnerId = createProfileBoundNativeDocumentOwnerId(profileKey);
    this.nativeDocumentProfile = profileKey;
  }

  isCurrent(snapshot: SidecarSessionSnapshot): boolean {
    return (
      snapshot.owner === this.owner &&
      snapshot.generation === this.generation &&
      snapshot.state === this.state &&
      snapshot.token === this.token
    );
  }

  currentToken(): string {
    if (this.state !== 'ready') {
      throw new SidecarSessionUnavailableError(this.state);
    }
    return this.token;
  }

  humanOperationToken(snapshot: SidecarSessionSnapshot): string | undefined {
    if (!this.isCurrent(snapshot) || this.state === 'stopped') {
      throw new SidecarSessionUnavailableError(this.state);
    }
    return this.humanToken;
  }

  nativeDocumentAuthority(
    snapshot: SidecarSessionSnapshot
  ): { readonly token: string; readonly ownerInstanceId: string } | undefined {
    if (!this.isCurrent(snapshot) || this.state === 'stopped') {
      throw new SidecarSessionUnavailableError(this.state);
    }
    return this.nativeDocumentToken && this.nativeDocumentOwnerId
      ? { token: this.nativeDocumentToken, ownerInstanceId: this.nativeDocumentOwnerId }
      : undefined;
  }

  waitForReadySnapshot(timeoutMs = 30_000, signal?: AbortSignal): Promise<SidecarSessionSnapshot> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.state === 'ready') return Promise.resolve(this.snapshot());
    if (this.state === 'stopped' || this.state === 'error' || this.state === 'timeout') {
      return Promise.reject(new SidecarSessionUnavailableError(this.state));
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.readyWaiters.delete(waiter);
      };
      const waiter: SidecarReadyWaiter = {
        resolve: (snapshot) => {
          cleanup();
          resolve(snapshot);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = (): void => waiter.reject(signal?.reason);
      const timer = setTimeout(
        () => waiter.reject(new SidecarSessionUnavailableError(this.state)),
        timeoutMs
      );
      this.readyWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  markRestarting(): void {
    if (this.state !== 'stopped') {
      this.state = 'restarting';
      this.publish();
    }
  }

  prepareManagedSpawn(reason: SidecarSpawnReason): SidecarSessionSnapshot {
    if (this.state === 'stopped') throw new SidecarSessionUnavailableError(this.state);
    if (this.owner === 'electron') {
      this.token = this.mintToken();
      this.humanToken = defaultMintToken();
      this.nativeDocumentToken = defaultMintToken();
    }
    this.generation += 1;
    this.state = reason === 'initial' ? 'starting' : 'restarting';
    this.publish();
    return this.snapshot();
  }

  markReady(generation: number): boolean {
    if (generation !== this.generation || this.state === 'stopped') return false;
    this.state = 'ready';
    this.publish();
    const snapshot = this.snapshot();
    for (const waiter of this.readyWaiters) {
      waiter.resolve(snapshot);
    }
    this.readyWaiters.clear();
    return true;
  }

  markFailed(generation: number, state: 'error' | 'timeout'): boolean {
    if (generation !== this.generation || this.state === 'stopped') return false;
    this.state = state;
    this.publish();
    this.rejectReadyWaiters();
    return true;
  }

  markStopped(): void {
    this.state = 'stopped';
    this.publish();
    this.rejectReadyWaiters();
  }

  private rejectReadyWaiters(): void {
    const error = new SidecarSessionUnavailableError(this.state);
    for (const waiter of this.readyWaiters) {
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }
}
