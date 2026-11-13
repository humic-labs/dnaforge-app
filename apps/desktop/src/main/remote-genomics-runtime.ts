import { randomUUID } from 'node:crypto';
import { assertRemoteReadBackend } from './remote-read-backend';
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import type {
  RemoteAlignmentConnectRequestV1,
  RemoteAlignmentLocatorV1,
  RemoteAlignmentMaterializationV1,
  RemoteSignalConnectRequestV1,
  RemoteSignalLocatorV1,
  RemoteSignalMaterializationV1,
  RemoteFileReceiptV1,
  RemoteGenomicsRuntimeStateV1,
  RemoteGenomicsRuntimeStatusEventV1,
  RemoteGenomicsRuntimeStatusV1,
  RemoteSshFailureCode,
  RemoteSshFailureV1,
} from '../shared/remote-genomics-ipc';
import {
  REMOTE_SOURCE_CHANGED_MESSAGE,
  RemoteGenomicsError,
  proveForwardedRange,
  remoteGenomicsSupervisor,
} from './remote-genomics-supervisor';
import {
  RemoteByteCache,
  RemoteByteReadCancelled,
  serveRemoteByteRange,
} from './remote-byte-cache';

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const INITIAL_CONNECT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;
const DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_WAIT_TIMEOUT_MS = 360_000;

export interface RemoteGenomicsTransportProvider {
  connect(
    request: RemoteAlignmentConnectRequestV1,
    signal?: AbortSignal
  ): Promise<RemoteAlignmentMaterializationV1>;
  connectSignal?(
    request: RemoteSignalConnectRequestV1,
    signal?: AbortSignal
  ): Promise<RemoteSignalMaterializationV1>;
  disconnect(sessionId: string): Promise<boolean>;
  subscribeSession(sessionId: string, listener: () => void): () => void;
}

type RemoteSourceRequest = RemoteAlignmentConnectRequestV1 | RemoteSignalConnectRequestV1;
type RemoteSourceMaterialization = RemoteAlignmentMaterializationV1 | RemoteSignalMaterializationV1;
type RemoteSourceLocator = RemoteAlignmentLocatorV1 | RemoteSignalLocatorV1;
type RemoteSourceGeneration = {
  readonly alignment?: RemoteFileReceiptV1;
  readonly index?: RemoteFileReceiptV1;
  readonly signal?: RemoteFileReceiptV1;
  readonly reference?: RemoteFileReceiptV1;
  readonly referenceIndex?: RemoteFileReceiptV1;
};

interface ManagedRemoteSource {
  readonly keys: Set<string>;
  readonly blockedPredecessor: ManagedRemoteSource | null;
  readonly sourceId: string;
  request: RemoteSourceRequest;
  readonly leases: Set<string>;
  readonly disconnectingTransports: Set<Promise<boolean>>;
  readonly cacheRootPromise: Promise<string | null>;
  stableIndexPath: string | null;
  lastLocator: RemoteSourceLocator | null;
  admittedGeneration: RemoteSourceGeneration | null;
  transport: RemoteSourceMaterialization | null;
  unsubscribeTransport: (() => void) | null;
  reconcilePromise: Promise<void> | null;
  connectController: AbortController | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setTimeout> | null;
  activeGatewayRequests: number;
  wakeRetry: (() => void) | null;
  waitingConnects: number;
  attempt: number;
  state: RemoteGenomicsRuntimeStateV1;
  nextRetryAt: number | null;
  transportGeneration: number;
  lastFailure: RemoteSshFailureV1 | null;
  updatedAt: number;
  stopped: boolean;
  disposingPromise: Promise<void> | null;
}

interface RuntimeOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly retryJitterRatio?: number;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly upstreamRequestTimeoutMs?: number;
  readonly healthCheckIntervalMs?: number;
  readonly healthCheckTimeoutMs?: number;
  readonly connectWaitTimeoutMs?: number;
}

interface PendingRuntimeConnect {
  readonly cancellation: Promise<never>;
  readonly cancel: () => void;
}

class RemoteGenomicsConnectCancelled extends Error {
  constructor() {
    super('Remote file connection was cancelled.');
    this.name = 'RemoteGenomicsConnectCancelled';
  }
}

class GatewayClientCancelledError extends Error {
  constructor() {
    super('The range reader stopped waiting for this response.');
    this.name = 'GatewayClientCancelledError';
  }
}

export class RemoteGenomicsRuntime {
  private readonly byteCache = new RemoteByteCache();
  private readonly sourcesByKey = new Map<string, ManagedRemoteSource>();
  private readonly sourcesById = new Map<string, ManagedRemoteSource>();
  private readonly leaseSourceIds = new Map<string, string>();
  private readonly pendingConnects = new Map<string, PendingRuntimeConnect>();
  private readonly listeners = new Set<(event: RemoteGenomicsRuntimeStatusEventV1) => void>();
  private readonly retryDelaysMs: readonly number[];
  private readonly retryJitterRatio: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly upstreamRequestTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly connectWaitTimeoutMs: number;
  private gateway: Server | null = null;
  private gatewayPort: number | null = null;
  private gatewayStarting: Promise<number> | null = null;
  private sequence = 0;
  private stopping = false;
  private stoppingPromise: Promise<void> | null = null;

  constructor(
    private readonly provider: RemoteGenomicsTransportProvider,
    options: RuntimeOptions = {}
  ) {
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : DEFAULT_RETRY_DELAYS_MS;
    this.retryJitterRatio = Math.max(
      0,
      Math.min(1, options.retryJitterRatio ?? DEFAULT_RETRY_JITTER_RATIO)
    );
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.upstreamRequestTimeoutMs = Math.max(
      1,
      options.upstreamRequestTimeoutMs ?? DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS
    );
    this.healthCheckIntervalMs = Math.max(
      0,
      options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
    );
    this.healthCheckTimeoutMs = Math.max(
      1,
      options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS
    );
    this.connectWaitTimeoutMs = Math.max(
      1,
      options.connectWaitTimeoutMs ?? DEFAULT_CONNECT_WAIT_TIMEOUT_MS
    );
  }

  connect(request: RemoteAlignmentConnectRequestV1): Promise<RemoteAlignmentMaterializationV1> {
    return this.connectSource(request);
  }

  connectSignal(request: RemoteSignalConnectRequestV1): Promise<RemoteSignalMaterializationV1> {
    return this.connectSource(request);
  }

  private connectSource(
    request: RemoteAlignmentConnectRequestV1
  ): Promise<RemoteAlignmentMaterializationV1>;
  private connectSource(
    request: RemoteSignalConnectRequestV1
  ): Promise<RemoteSignalMaterializationV1>;
  private async connectSource(request: RemoteSourceRequest): Promise<RemoteSourceMaterialization> {
    if (this.stopping) throw new Error('The remote genomics runtime is stopping.');
    if ('alignmentPath' in request) assertRemoteReadBackend(request);
    const pending = request.requestId ? this.beginPendingConnect(request.requestId) : null;
    let source: ManagedRemoteSource | null = null;
    let waitingRegistered = false;
    let connected = false;
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const deadlineTimer = setTimeout(
      () =>
        rejectDeadline(
          new RemoteGenomicsError(
            'connection-timeout',
            `Connection to ${request.displayName || request.target} is taking too long. Check the endpoint and try again.`
          )
        ),
      this.connectWaitTimeoutMs
    );
    try {
      const gatewayPort = await Promise.race([
        raceCancellation(this.ensureGateway(), pending),
        deadline,
      ]);
      if (this.stopping) throw new Error('The remote genomics runtime is stopping.');
      source = this.sourceFor(request);
      source.waitingConnects += 1;
      waitingRegistered = true;
      source.wakeRetry?.();
      if (request.allowInteractive && request.requestId && source.reconcilePromise) {
        await Promise.race([
          raceCancellation(
            source.reconcilePromise.catch(() => undefined),
            pending
          ),
          deadline,
        ]);
      }
      let transport: RemoteSourceMaterialization;
      for (;;) {
        await Promise.race([
          raceCancellation(this.reconcile(source, request.allowInteractive === true), pending),
          deadline,
        ]);
        if (source.transport && (!('alignmentPath' in request) || source.stableIndexPath)) {
          transport = source.transport;
          break;
        }
      }
      const leaseId = randomUUID();
      source.leases.add(leaseId);
      this.leaseSourceIds.set(leaseId, source.sourceId);
      connected = true;
      const baseUrl = `http://127.0.0.1:${gatewayPort}/v1/${source.sourceId}`;
      const common = {
        sessionId: leaseId,
        runtimeStatus: this.statusFor(source),
      };
      if ('bamUrl' in transport) {
        const alignmentExtension = transport.bamUrl.toLowerCase().includes('.cram')
          ? '.cram'
          : '.bam';
        return {
          ...transport,
          ...common,
          bamUrl: `${baseUrl}/alignment${alignmentExtension}`,
          ...(transport.tileBaseUrl ? { tileBaseUrl: `${baseUrl}/compute` } : {}),
          indexPath: source.stableIndexPath!,
          ...(transport.bigWigUrl ? { bigWigUrl: `${baseUrl}/signal.bigWig` } : {}),
        };
      }
      return { ...transport, ...common, bigWigUrl: `${baseUrl}/signal.bigWig` };
    } finally {
      clearTimeout(deadlineTimer);
      if (request.requestId && this.pendingConnects.get(request.requestId) === pending) {
        this.pendingConnects.delete(request.requestId);
      }
      if (source && waitingRegistered) {
        source.waitingConnects = Math.max(0, source.waitingConnects - 1);
      }
      if (source && !connected && source.waitingConnects === 0 && source.leases.size === 0) {
        await this.disposeSource(source);
      }
    }
  }

  cancelConnect(requestId: string): boolean {
    const pending = this.pendingConnects.get(requestId);
    if (!pending) return false;
    pending.cancel();
    return true;
  }

  async disconnect(leaseId: string): Promise<boolean> {
    const sourceId = this.leaseSourceIds.get(leaseId);
    if (!sourceId) return false;
    this.leaseSourceIds.delete(leaseId);
    const source = this.sourcesById.get(sourceId);
    if (!source) return false;
    source.leases.delete(leaseId);
    if (source.leases.size === 0 && source.waitingConnects === 0) {
      await this.disposeSource(source);
    }
    return true;
  }

  listStatuses(): RemoteGenomicsRuntimeStatusV1[] {
    return [...this.sourcesById.values()]
      .map((source) => this.statusFor(source))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  }

  subscribe(listener: (event: RemoteGenomicsRuntimeStatusEventV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  retryEndpoint(endpointIdOrTarget: string): boolean {
    let matched = false;
    for (const source of this.sourcesById.values()) {
      if (
        source.sourceId !== endpointIdOrTarget &&
        source.request.endpointId !== endpointIdOrTarget &&
        source.request.target !== endpointIdOrTarget
      ) {
        continue;
      }
      if (source.lastFailure?.code === 'source-changed') continue;
      matched = true;
      if (source.transport) {
        void this.markTransportUnhealthy(source, source.transport.sessionId).catch(() => undefined);
      } else if (source.wakeRetry) {
        source.wakeRetry();
      } else if (source.reconcilePromise) {
        const currentReconcile = source.reconcilePromise;
        void currentReconcile
          .finally(() => {
            if (
              !source.stopped &&
              !source.transport &&
              source.reconcilePromise === null &&
              (source.leases.size > 0 || source.waitingConnects > 0)
            ) {
              void this.reconcile(source, true).catch(() => undefined);
            }
          })
          .catch(() => undefined);
      } else if (!source.transport) {
        void this.reconcile(source, true).catch(() => undefined);
      }
    }
    return matched;
  }

  stopAll(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stopping = true;
    for (const pending of this.pendingConnects.values()) pending.cancel();
    this.pendingConnects.clear();
    this.stoppingPromise = (async () => {
      const sources = [...this.sourcesById.values()];
      await Promise.all(sources.map((source) => this.disposeSource(source)));
      await this.gatewayStarting?.catch(() => undefined);
      this.sourcesByKey.clear();
      this.sourcesById.clear();
      this.leaseSourceIds.clear();
      const gateway = this.gateway;
      this.gateway = null;
      this.gatewayPort = null;
      if (gateway) {
        await new Promise<void>((resolve) => {
          gateway.close(() => resolve());
          gateway.closeAllConnections();
        });
      }
    })();
    return this.stoppingPromise;
  }

  private beginPendingConnect(requestId: string): PendingRuntimeConnect {
    if (this.pendingConnects.has(requestId)) {
      throw new RemoteGenomicsError('invalid-request', 'Remote connection request ID is in use.');
    }
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const pending: PendingRuntimeConnect = {
      cancellation,
      cancel: () => rejectCancellation(new RemoteGenomicsConnectCancelled()),
    };
    this.pendingConnects.set(requestId, pending);
    return pending;
  }

  private sourceFor(request: RemoteSourceRequest): ManagedRemoteSource {
    const key = sourceKey(request);
    const current = this.sourcesByKey.get(key);
    const readmittingChangedSource =
      current &&
      !current.stopped &&
      current.lastFailure?.code === 'source-changed' &&
      request.allowInteractive === true &&
      Boolean(request.requestId);
    if (current && !current.stopped && !readmittingChangedSource) {
      if (request.allowInteractive && request.requestId) {
        current.request = {
          ...current.request,
          requestId: request.requestId,
          allowInteractive: true,
        };
      }
      return current;
    }
    const now = this.now();
    const source: ManagedRemoteSource = {
      keys: new Set([key]),
      blockedPredecessor: readmittingChangedSource
        ? current!
        : (current?.blockedPredecessor ?? null),
      sourceId: randomUUID(),
      request: { ...request },
      leases: new Set(),
      disconnectingTransports: new Set(),
      cacheRootPromise:
        'alignmentPath' in request
          ? mkdtemp(join(tmpdir(), 'dnaforge-remote-source-'))
          : Promise.resolve(null),
      stableIndexPath: null,
      lastLocator: null,
      admittedGeneration: null,
      transport: null,
      unsubscribeTransport: null,
      reconcilePromise: null,
      connectController: null,
      retryTimer: null,
      healthTimer: null,
      activeGatewayRequests: 0,
      wakeRetry: null,
      waitingConnects: 0,
      attempt: 0,
      state: 'connecting',
      nextRetryAt: null,
      transportGeneration: 0,
      lastFailure: null,
      updatedAt: now,
      stopped: false,
      disposingPromise: null,
    };
    this.sourcesByKey.set(key, source);
    this.sourcesById.set(source.sourceId, source);
    this.publish(source, 'created');
    return source;
  }

  private reconcile(source: ManagedRemoteSource, retryBlocked = false): Promise<void> {
    if (source.transport) return Promise.resolve();
    if (source.reconcilePromise) return source.reconcilePromise;
    if (
      source.lastFailure?.code === 'source-changed' ||
      (!retryBlocked && (source.state === 'needs-authentication' || source.state === 'blocked'))
    ) {
      const failure = source.lastFailure;
      return Promise.reject(
        new RemoteGenomicsError(
          failure?.code ?? 'helper-failed',
          failure?.message ?? 'This remote connection needs an explicit reconnect.'
        )
      );
    }
    const run = (async () => {
      for (;;) {
        if (this.stopping || source.stopped) {
          throw new Error('The remote source was released.');
        }
        source.state = source.transportGeneration === 0 ? 'connecting' : 'retrying';
        source.nextRetryAt = null;
        source.updatedAt = this.now();
        this.publish(source, 'connecting');
        if (this.stopping || source.stopped) throw new Error('The remote source was released.');
        const connectController = new AbortController();
        source.connectController = connectController;
        try {
          const transport =
            'alignmentPath' in source.request
              ? await this.provider.connect(source.request, connectController.signal)
              : await this.connectSignalTransport(source.request, connectController.signal);
          if (this.stopping || source.stopped) {
            await this.provider.disconnect(transport.sessionId).catch(() => false);
            throw new Error('The remote source was released.');
          }
          try {
            await this.installTransport(source, transport);
          } catch (error) {
            await this.provider.disconnect(transport.sessionId).catch(() => false);
            throw error;
          }
          return;
        } catch (error) {
          if (this.stopping || source.stopped) throw error;
          const failure = remoteFailure(error);
          source.lastFailure = failure;
          source.attempt += 1;
          const autoRetryAllowed =
            retryableRemoteFailure(failure.code) &&
            failure.code !== 'authentication-required' &&
            failure.code !== 'host-trust-failed' &&
            (source.transportGeneration > 0 || source.attempt < INITIAL_CONNECT_MAX_ATTEMPTS);
          source.state =
            failure.code === 'authentication-required' || failure.code === 'host-trust-failed'
              ? 'needs-authentication'
              : autoRetryAllowed
                ? 'retrying'
                : 'blocked';
          source.updatedAt = this.now();
          if (!autoRetryAllowed) {
            source.nextRetryAt = null;
            this.publish(source, 'blocked');
            throw error;
          }
          const delayMs = this.retryDelay(source.attempt - 1);
          source.nextRetryAt = this.now() + delayMs;
          this.publish(source, 'retrying');
          await this.waitForRetry(source, delayMs);
        } finally {
          if (source.connectController === connectController) source.connectController = null;
        }
      }
    })();
    source.reconcilePromise = run;
    void run.then(
      () => {
        if (source.reconcilePromise === run) {
          source.reconcilePromise = null;
          if (
            !source.transport &&
            !source.stopped &&
            (source.leases.size > 0 || source.waitingConnects > 0)
          ) {
            void this.reconcile(source).catch(() => undefined);
          }
        }
      },
      () => {
        if (source.reconcilePromise === run) source.reconcilePromise = null;
      }
    );
    return run;
  }

  private connectSignalTransport(
    request: RemoteSignalConnectRequestV1,
    signal: AbortSignal
  ): Promise<RemoteSignalMaterializationV1> {
    if (!this.provider.connectSignal) {
      throw new RemoteGenomicsError(
        'invalid-request',
        'This SSH provider does not support remote BigWig admission.'
      );
    }
    return this.provider.connectSignal(request, signal);
  }

  private async installTransport(
    source: ManagedRemoteSource,
    transport: RemoteSourceMaterialization
  ): Promise<void> {
    if (
      source.admittedGeneration &&
      !sameRemoteGeneration(source.admittedGeneration, transport.generation)
    ) {
      throw new RemoteGenomicsError('source-changed', REMOTE_SOURCE_CHANGED_MESSAGE);
    }
    let stableIndexPath: string | null = null;
    let stagedIndexPath: string | null = null;
    let unsubscribeCandidate: (() => void) | null = null;
    let closedBeforeCommit = false;
    try {
      if ('indexPath' in transport) {
        const cacheRoot = await source.cacheRootPromise;
        if (!cacheRoot) throw new Error('An alignment transport requires an owned index cache.');
        const extension = normalizedIndexExtension(transport.indexPath);
        stableIndexPath = source.stableIndexPath ?? join(cacheRoot, `alignment${extension}`);
        stagedIndexPath = `${stableIndexPath}.${randomUUID()}.part`;
        await copyFile(transport.indexPath, stagedIndexPath);
        await rename(stagedIndexPath, stableIndexPath);
      }

      unsubscribeCandidate = this.provider.subscribeSession(transport.sessionId, () => {
        if (source.transport?.sessionId === transport.sessionId) {
          this.transportClosed(source, transport.sessionId);
        } else {
          closedBeforeCommit = true;
        }
      });
      if (closedBeforeCommit) {
        throw new RemoteGenomicsError(
          'tunnel-failed',
          'The SSH transport closed while the remote file was being attached.'
        );
      }
      if (this.stopping || source.stopped) {
        throw new Error('The remote source was released.');
      }

      source.stableIndexPath = stableIndexPath;
      source.lastLocator = transport.locator;
      source.admittedGeneration = transport.generation;
      const resolvedKey = sourceKey(transport.locator);
      const resolvedSource = this.sourcesByKey.get(resolvedKey);
      if (
        !resolvedSource ||
        resolvedSource.stopped ||
        resolvedSource === source ||
        (resolvedSource === source.blockedPredecessor &&
          resolvedSource.lastFailure?.code === 'source-changed')
      ) {
        this.sourcesByKey.set(resolvedKey, source);
        source.keys.add(resolvedKey);
      }
      const predecessor = source.blockedPredecessor;
      if (
        predecessor?.lastLocator &&
        sameCanonicalLocator(predecessor.lastLocator, transport.locator)
      ) {
        const canonicalKeys = canonicalSourceKeys(transport.locator);
        for (const alias of predecessor.keys) {
          if (canonicalKeys.has(alias) && this.sourcesByKey.get(alias) === predecessor) {
            this.sourcesByKey.set(alias, source);
            source.keys.add(alias);
          }
        }
      }
      source.unsubscribeTransport?.();
      source.transport = transport;
      source.unsubscribeTransport = unsubscribeCandidate;
      unsubscribeCandidate = null;
      source.transportGeneration += 1;
      source.attempt = 0;
      source.state = 'online';
      source.nextRetryAt = null;
      source.lastFailure = null;
      source.updatedAt = this.now();
      this.publish(source, 'connected');
      this.scheduleTransportHealthCheck(source, transport);
    } catch (error) {
      unsubscribeCandidate?.();
      if (stagedIndexPath) await rm(stagedIndexPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private transportClosed(source: ManagedRemoteSource, transportSessionId: string): void {
    if (source.stopped || source.transport?.sessionId !== transportSessionId) return;
    void this.byteCache.invalidateSource(source.sourceId);
    console.warn('[remote-genomics] serving transport closed:', {
      cause: 'provider-session-closed',
      transportGeneration: source.transportGeneration,
      activeGatewayRequests: source.activeGatewayRequests,
    });
    this.clearTransportHealthCheck(source);
    source.unsubscribeTransport?.();
    source.unsubscribeTransport = null;
    source.transport = null;
    source.state = 'retrying';
    source.attempt = 0;
    source.nextRetryAt = this.now();
    source.lastFailure = {
      code: 'tunnel-failed',
      message: 'The SSH transport closed unexpectedly.',
    };
    source.updatedAt = this.now();
    this.publish(source, 'transport-closed');
    if (source.leases.size > 0 || source.waitingConnects > 0) {
      void this.reconcile(source).catch(() => undefined);
    }
  }

  private async markTransportUnhealthy(
    source: ManagedRemoteSource,
    transportSessionId: string
  ): Promise<void> {
    if (source.transport?.sessionId !== transportSessionId) return;
    void this.byteCache.invalidateSource(source.sourceId);
    this.clearTransportHealthCheck(source);
    source.unsubscribeTransport?.();
    source.unsubscribeTransport = null;
    source.transport = null;
    source.state = 'retrying';
    source.attempt = 0;
    source.nextRetryAt = this.now();
    source.lastFailure = {
      code: 'tunnel-failed',
      message: 'The SSH transport stopped answering range requests.',
    };
    source.updatedAt = this.now();
    const disconnecting = this.disconnectTransport(source, transportSessionId);
    this.publish(source, 'transport-closed');

    if (
      !source.stopped &&
      !source.transport &&
      !source.reconcilePromise &&
      (source.leases.size > 0 || source.waitingConnects > 0)
    ) {
      void this.reconcile(source).catch(() => undefined);
    }
    await disconnecting;
  }

  private async blockChangedSource(
    source: ManagedRemoteSource,
    transportSessionId: string,
    error: RemoteGenomicsError
  ): Promise<void> {
    if (source.stopped || source.transport?.sessionId !== transportSessionId) return;
    void this.byteCache.invalidateSource(source.sourceId);
    this.clearTransportHealthCheck(source);
    source.unsubscribeTransport?.();
    source.unsubscribeTransport = null;
    source.transport = null;
    source.state = 'blocked';
    source.nextRetryAt = null;
    source.lastFailure = remoteFailure(error);
    source.updatedAt = this.now();
    const disconnecting = this.disconnectTransport(source, transportSessionId);
    this.publish(source, 'blocked');
    await disconnecting;
  }

  private disconnectTransport(source: ManagedRemoteSource, sessionId: string): Promise<boolean> {
    const disconnecting = this.provider.disconnect(sessionId).catch(() => false);
    source.disconnectingTransports.add(disconnecting);
    void disconnecting.then(() => source.disconnectingTransports.delete(disconnecting));
    return disconnecting;
  }

  private scheduleTransportHealthCheck(
    source: ManagedRemoteSource,
    transport: RemoteSourceMaterialization
  ): void {
    this.clearTransportHealthCheck(source);
    if (this.healthCheckIntervalMs === 0 || source.stopped) return;
    const timer = setTimeout(() => {
      if (source.healthTimer === timer) source.healthTimer = null;
      void this.checkTransportHealth(source, transport).catch(() => undefined);
    }, this.healthCheckIntervalMs);
    timer.unref?.();
    source.healthTimer = timer;
  }

  private clearTransportHealthCheck(source: ManagedRemoteSource): void {
    if (source.healthTimer) clearTimeout(source.healthTimer);
    source.healthTimer = null;
  }

  private async checkTransportHealth(
    source: ManagedRemoteSource,
    transport: RemoteSourceMaterialization
  ): Promise<void> {
    if (source.stopped || source.transport?.sessionId !== transport.sessionId) return;
    if (source.activeGatewayRequests > 0) {
      this.scheduleTransportHealthCheck(source, transport);
      return;
    }
    const checkedAt = Date.now();
    try {
      await probeLoopbackHealth(
        'bamUrl' in transport ? transport.bamUrl : transport.bigWigUrl,
        this.healthCheckTimeoutMs
      );
    } catch (error) {
      if (source.stopped || source.transport?.sessionId !== transport.sessionId) return;
      console.warn('[remote-genomics] health probe failed before transport retirement:', {
        at: Date.now(),
        elapsedMs: Date.now() - checkedAt,
        timeoutMs: this.healthCheckTimeoutMs,
        servingTransportStillCurrent: source.transport?.sessionId === transport.sessionId,
        sourceStopped: source.stopped,
        cause:
          error instanceof RemoteGenomicsError && error.code === 'source-changed'
            ? 'source-changed'
            : error instanceof Error && /timed out|timeout/iu.test(error.message)
              ? 'probe-timeout'
              : 'probe-network-or-response',
      });
      if (error instanceof RemoteGenomicsError && error.code === 'source-changed') {
        await this.blockChangedSource(source, transport.sessionId, error);
      } else if (source.activeGatewayRequests > 0) {
        this.scheduleTransportHealthCheck(source, transport);
      } else {
        await this.markTransportUnhealthy(source, transport.sessionId);
      }
      return;
    }
    if (!source.stopped && source.transport?.sessionId === transport.sessionId) {
      this.scheduleTransportHealthCheck(source, transport);
    }
  }

  private async ensureGateway(): Promise<number> {
    if (this.stopping) throw new Error('The remote genomics runtime is stopping.');
    if (this.gatewayPort !== null) return this.gatewayPort;
    if (this.gatewayStarting) return this.gatewayStarting;
    const starting = new Promise<number>((resolve, reject) => {
      const gateway = createServer((request, response) => {
        void this.handleGatewayRequest(request, response);
      });
      gateway.once('error', reject);
      gateway.listen(0, '127.0.0.1', () => {
        if (this.stopping) {
          gateway.close(() => reject(new Error('The remote genomics runtime is stopping.')));
          gateway.closeAllConnections();
          return;
        }
        const address = gateway.address();
        if (!address || typeof address === 'string') {
          gateway.close();
          reject(new Error('The remote-source gateway did not bind TCP.'));
          return;
        }
        this.gateway = gateway;
        this.gatewayPort = address.port;
        resolve(address.port);
      });
    });
    this.gatewayStarting = starting;
    try {
      return await starting;
    } finally {
      if (this.gatewayStarting === starting) this.gatewayStarting = null;
    }
  }

  private async handleGatewayRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const tile =
      /^\/v1\/([^/]+)\/compute(\/tiles\/(?:alignment\/(?:read|header)|(?:alignment|coverage|coverage-assembly)\/\d+\/\d+))$/u.exec(
        request.url ?? ''
      );
    if (tile) {
      await this.handleTileGatewayRequest(request, response, tile[1], tile[2]);
      return;
    }
    const match = /^\/v1\/([^/]+)\/(alignment\.(?:bam|cram)|signal\.bigWig)$/u.exec(
      request.url?.split('?', 1)[0] ?? ''
    );
    if (!match || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404).end();
      return;
    }
    const sourceId = match[1];
    const resourcePath = match[2];
    if (!sourceId || !resourcePath) {
      response.writeHead(404).end();
      return;
    }
    const source = this.sourcesById.get(sourceId);
    if (!source || source.stopped) {
      response.writeHead(404).end();
      return;
    }
    const clientLifetime = gatewayClientLifetime(request, response);
    source.activeGatewayRequests += 1;
    const resource = resourcePath.startsWith('alignment.') ? 'alignment' : 'signal';
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let attemptedTransportSessionId: string | null = null;
        let attemptedUpstreamUrl: string | null = null;
        try {
          await raceClientCancellation(this.reconcile(source), clientLifetime.signal);
          const transport = source.transport;
          if (!transport) throw new Error('The remote source is not online.');
          attemptedTransportSessionId = transport.sessionId;
          const upstreamUrl =
            resource === 'alignment'
              ? 'bamUrl' in transport
                ? transport.bamUrl
                : undefined
              : transport.bigWigUrl;
          if (!upstreamUrl) {
            response.writeHead(404).end();
            return;
          }
          attemptedUpstreamUrl = upstreamUrl;
          const receipt =
            resource === 'alignment'
              ? 'alignment' in transport.generation
                ? transport.generation.alignment
                : undefined
              : transport.generation.signal;
          if (
            receipt &&
            (await serveRemoteByteRange({
              incoming: request,
              outgoing: response,
              upstreamUrl,
              receipt,
              namespace: `${source.sourceId}:${source.transportGeneration}:${resource}`,
              cache: this.byteCache,
              timeoutMs: this.upstreamRequestTimeoutMs,
              signal: clientLifetime.signal,
              isCurrent: () => !source.stopped && source.transport === transport,
            }))
          )
            return;
          await proxyLoopbackRequest(
            request,
            response,
            upstreamUrl,
            this.upstreamRequestTimeoutMs,
            clientLifetime.signal
          );
          return;
        } catch (error) {
          if (
            error instanceof GatewayClientCancelledError ||
            (error instanceof RemoteByteReadCancelled && clientLifetime.signal.aborted)
          )
            return;
          let responseFailure = error;
          let changedResponse =
            error instanceof RemoteGenomicsError &&
            error.code === 'source-changed' &&
            attemptedTransportSessionId !== null;

          if (attemptedTransportSessionId) {
            if (changedResponse) {
              await this.blockChangedSource(
                source,
                attemptedTransportSessionId,
                error as RemoteGenomicsError
              );
            } else {
              if (clientLifetime.signal.aborted) return;
              let confirmedReadable = false;
              if (
                !source.stopped &&
                source.transport?.sessionId === attemptedTransportSessionId &&
                attemptedUpstreamUrl
              ) {
                try {
                  const capturedGeneration = source.transportGeneration;
                  await confirmFailedRangeChannel(
                    attemptedUpstreamUrl,
                    Math.min(this.upstreamRequestTimeoutMs, this.healthCheckTimeoutMs),
                    clientLifetime.signal,
                    () => ({
                      capturedGeneration,
                      currentGeneration: source.transportGeneration,
                      capturedTransportStillCurrent:
                        source.transport?.sessionId === attemptedTransportSessionId,
                      sourceStopped: source.stopped,
                    })
                  );
                  confirmedReadable = true;
                } catch (confirmationError) {
                  if (
                    confirmationError instanceof RemoteGenomicsError &&
                    confirmationError.code === 'source-changed'
                  ) {
                    changedResponse = true;
                    responseFailure = confirmationError;
                    await this.blockChangedSource(
                      source,
                      attemptedTransportSessionId,
                      confirmationError
                    );
                  } else if (clientLifetime.signal.aborted) {
                    return;
                  }
                }
              }
              if (
                !changedResponse &&
                !confirmedReadable &&
                !source.stopped &&
                source.transport?.sessionId === attemptedTransportSessionId
              ) {
                const errorCode = (error as { code?: unknown } | null)?.code;
                console.warn(
                  '[remote-genomics] serving request failed before transport retirement:',
                  {
                    cause: 'foreground-request',
                    transportGeneration: source.transportGeneration,
                    resource,
                    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
                    reason:
                      error instanceof Error &&
                      error.message === 'The SSH range transport stopped responding.'
                        ? 'upstream-idle-timeout'
                        : error instanceof Error &&
                            error.message.startsWith('The SSH range response ended early (')
                          ? 'upstream-incomplete-body'
                          : 'transport-error',
                    code:
                      typeof errorCode === 'string' &&
                      ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(errorCode)
                        ? errorCode
                        : null,
                    activeGatewayRequests: source.activeGatewayRequests,
                  }
                );
                await this.markTransportUnhealthy(source, attemptedTransportSessionId);
              }
              if (clientLifetime.signal.aborted) return;
            }
          }
          if (changedResponse || attempt === 1 || response.headersSent) {
            if (!response.headersSent && !response.destroyed) {
              response.writeHead(changedResponse ? 412 : 503, {
                'cache-control': 'no-store',
                ...(changedResponse ? {} : { 'retry-after': '1' }),
                'access-control-allow-origin': '*',
              });
            }
            if (!response.writableEnded && !response.destroyed) response.end();
            console.warn(
              '[remote-genomics] stable gateway request failed:',
              safeErrorMessage(responseFailure)
            );
            return;
          }
        }
      }
    } finally {
      source.activeGatewayRequests -= 1;
      clientLifetime.dispose();
    }
  }

  private async handleTileGatewayRequest(
    request: IncomingMessage,
    response: ServerResponse,
    sourceId: string,
    tilePath: string
  ): Promise<void> {
    const source = this.sourcesById.get(sourceId);
    if (
      !source ||
      source.stopped ||
      !('alignmentPath' in source.request) ||
      !source.request.tileServerReceiptPath
    ) {
      response.writeHead(404).end();
      return;
    }
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-expose-headers': 'X-DNAForge-Compute-Pid, X-DNAForge-Compute-Platform',
      'cache-control': 'no-store',
      'content-type': 'application/json',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(404, headers).end();
      return;
    }
    const lifetime = gatewayClientLifetime(request, response);
    source.activeGatewayRequests += 1;
    let transportSessionId: string | null = null;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > 1024 * 1024) {
          response.writeHead(413, headers).end('{"error":"REQUEST_TOO_LARGE"}');
          return;
        }
        chunks.push(buffer);
      }
      await raceClientCancellation(this.reconcile(source), lifetime.signal);
      const transport = source.transport;
      if (!transport || !('tileBaseUrl' in transport) || !transport.tileBaseUrl)
        throw new RemoteGenomicsError('helper-failed', 'Cluster calculation is unavailable.');
      transportSessionId = transport.sessionId;
      const upstream = await fetch(`${transport.tileBaseUrl}${tilePath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks),
        signal: AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(this.upstreamRequestTimeoutMs),
        ]),
      });
      if (upstream.status === 412) {
        await upstream.body?.cancel();
        await this.blockChangedSource(
          source,
          transportSessionId,
          new RemoteGenomicsError(
            'source-changed',
            'The cluster source changed. Reconnect to check the current files.'
          )
        );
        response.writeHead(412, headers).end('{"error":"SOURCE_GENERATION_CHANGED"}');
        return;
      }
      const reader = upstream.body?.getReader();
      const payload: Buffer[] = [];
      let received = 0;
      if (reader) {
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            received += item.value.byteLength;
            if (received > 64 * 1024 * 1024) {
              await reader.cancel();
              throw new RemoteGenomicsError(
                'helper-failed',
                'The cluster tile response is too large.'
              );
            }
            payload.push(Buffer.from(item.value));
          }
        } finally {
          reader.releaseLock();
        }
      }
      if (source.stopped || source.transport !== transport) {
        response.writeHead(503, headers).end('{"error":"TRANSPORT_REPLACED"}');
        return;
      }
      const computePid = upstream.headers.get('x-dnaforge-compute-pid');
      const computePlatform = upstream.headers.get('x-dnaforge-compute-platform');
      response.writeHead(upstream.status, {
        ...headers,
        'content-length': received,
        ...(computePid ? { 'x-dnaforge-compute-pid': computePid } : {}),
        ...(computePlatform ? { 'x-dnaforge-compute-platform': computePlatform } : {}),
      });
      response.end(Buffer.concat(payload));
      if (upstream.status === 503) await this.markTransportUnhealthy(source, transportSessionId);
    } catch {
      if (lifetime.signal.aborted) return;
      if (transportSessionId) await this.markTransportUnhealthy(source, transportSessionId);
      if (!response.headersSent) response.writeHead(503, headers);
      if (!response.writableEnded && !response.destroyed)
        response.end('{"error":"CLUSTER_CALCULATION_UNAVAILABLE"}');
    } finally {
      source.activeGatewayRequests -= 1;
      lifetime.dispose();
    }
  }

  private retryDelay(completedAttempts: number): number {
    const base =
      this.retryDelaysMs[Math.min(completedAttempts, this.retryDelaysMs.length - 1)] ?? 0;
    if (base <= 0 || this.retryJitterRatio === 0) return Math.max(0, base);
    const jitter = (this.random() * 2 - 1) * this.retryJitterRatio;
    return Math.max(0, Math.round(base * (1 + jitter)));
  }

  private waitForRetry(source: ManagedRemoteSource, delayMs: number): Promise<void> {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (source.retryTimer) clearTimeout(source.retryTimer);
        source.retryTimer = null;
        source.wakeRetry = null;
        resolve();
      };
      source.retryTimer = setTimeout(finish, delayMs);
      source.wakeRetry = finish;
    });
  }

  private disposeSource(source: ManagedRemoteSource): Promise<void> {
    if (source.disposingPromise) return source.disposingPromise;
    source.stopped = true;
    source.disposingPromise = (async () => {
      const byteCleanup = this.byteCache.invalidateSource(source.sourceId);
      source.connectController?.abort();
      this.clearTransportHealthCheck(source);
      source.wakeRetry?.();
      source.unsubscribeTransport?.();
      source.unsubscribeTransport = null;
      const transportSessionId = source.transport?.sessionId;
      source.transport = null;
      if (transportSessionId) this.disconnectTransport(source, transportSessionId);
      await source.reconcilePromise?.catch(() => undefined);
      await Promise.all([...source.disconnectingTransports]);
      await byteCleanup;
      for (const leaseId of source.leases) this.leaseSourceIds.delete(leaseId);
      source.leases.clear();
      for (const key of source.keys) {
        if (this.sourcesByKey.get(key) !== source) continue;
        let predecessor = source.blockedPredecessor;
        while (predecessor?.stopped) predecessor = predecessor.blockedPredecessor;
        if (
          !this.stopping &&
          predecessor &&
          predecessor.keys.has(key) &&
          predecessor.lastFailure?.code === 'source-changed' &&
          this.sourcesById.get(predecessor.sourceId) === predecessor
        ) {
          this.sourcesByKey.set(key, predecessor);
        } else {
          this.sourcesByKey.delete(key);
        }
      }
      this.sourcesById.delete(source.sourceId);
      const cacheRoot = await source.cacheRootPromise.catch(() => null);
      if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
    })();
    return source.disposingPromise;
  }

  private statusFor(source: ManagedRemoteSource): RemoteGenomicsRuntimeStatusV1 {
    const locator = source.transport?.locator ?? source.lastLocator;
    return {
      sourceId: source.sourceId,
      endpointId:
        source.transport?.endpoint.endpointId ?? source.request.endpointId ?? source.request.target,
      target: source.request.target,
      displayName:
        source.transport?.endpoint.displayName ??
        source.request.displayName ??
        source.request.target,
      alignmentPath:
        locator && 'alignmentPath' in locator
          ? locator.alignmentPath
          : 'alignmentPath' in source.request
            ? source.request.alignmentPath
            : null,
      indexPath:
        locator && 'indexPath' in locator
          ? locator.indexPath
          : 'indexPath' in source.request
            ? (source.request.indexPath ?? null)
            : null,
      signalPath: locator?.signalPath ?? source.request.signalPath ?? null,
      state: source.state,
      attempt: source.attempt,
      nextRetryAt: source.nextRetryAt,
      transportGeneration: source.transportGeneration,
      lastFailure: source.lastFailure,
      updatedAt: source.updatedAt,
    };
  }

  private publish(
    source: ManagedRemoteSource,
    reason: RemoteGenomicsRuntimeStatusEventV1['reason']
  ): void {
    const event: RemoteGenomicsRuntimeStatusEventV1 = {
      sequence: ++this.sequence,
      reason,
      status: this.statusFor(source),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[remote-genomics] status listener failed:', safeErrorMessage(error));
      }
    }
  }
}

function sourceKey(request: RemoteSourceRequest): string {
  return 'alignmentPath' in request
    ? [
        'alignment',
        request.target.trim(),
        request.alignmentPath.trim(),
        request.indexPath?.trim() ?? '',
        request.signalPath?.trim() ?? '',
        request.tileServerReceiptPath?.trim() ?? '',
      ].join('\0')
    : ['signal', request.target.trim(), request.signalPath.trim()].join('\0');
}

function canonicalSourceKeys(locator: RemoteSourceLocator): Set<string> {
  if (!('alignmentPath' in locator)) return new Set([sourceKey(locator)]);
  return new Set([
    sourceKey(locator),
    sourceKey({ ...locator, indexPath: undefined }),
    sourceKey({ ...locator, signalPath: undefined }),
    sourceKey({ ...locator, indexPath: undefined, signalPath: undefined }),
  ]);
}

function sameCanonicalLocator(previous: RemoteSourceLocator, next: RemoteSourceLocator): boolean {
  return sourceKey(previous) === sourceKey(next);
}

function sameRemoteGeneration(
  admitted: RemoteSourceGeneration,
  candidate: RemoteSourceGeneration
): boolean {
  return (['alignment', 'index', 'signal', 'reference', 'referenceIndex'] as const).every(
    (asset) => {
      const previous = admitted[asset];
      const next = candidate[asset];
      if (!previous || !next) return previous === next;
      return (
        previous.canonicalPath === next.canonicalPath &&
        previous.size === next.size &&
        previous.mtimeNs === next.mtimeNs &&
        previous.ctimeNs === next.ctimeNs &&
        previous.device === next.device &&
        previous.inode === next.inode
      );
    }
  );
}

function raceCancellation<T>(work: Promise<T>, pending: PendingRuntimeConnect | null): Promise<T> {
  return pending ? Promise.race([work, pending.cancellation]) : work;
}

function normalizedIndexExtension(path: string): '.bai' | '.csi' | '.crai' {
  const extension = extname(path).toLowerCase();
  return extension === '.csi' || extension === '.crai' ? extension : '.bai';
}

function remoteFailure(error: unknown): RemoteSshFailureV1 {
  if (error instanceof RemoteGenomicsError) return { code: error.code, message: error.message };
  return {
    code: 'helper-failed',
    message: safeErrorMessage(error) || 'The remote streaming transport failed.',
  };
}

function retryableRemoteFailure(code: RemoteSshFailureCode): boolean {
  return (
    code === 'host-unreachable' ||
    code === 'tunnel-failed' ||
    code === 'connection-timeout' ||
    code === 'helper-failed' ||
    code === 'authentication-required' ||
    code === 'host-trust-failed'
  );
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proxyHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since', 'user-agent']) {
    const value = headers[name];
    if (value !== undefined) forwarded[name] = value;
  }
  return forwarded;
}

async function confirmFailedRangeChannel(
  upstreamUrl: string,
  timeoutMs: number,
  clientSignal: AbortSignal,
  context: () => {
    capturedGeneration: number;
    currentGeneration: number;
    capturedTransportStillCurrent: boolean;
    sourceStopped: boolean;
  }
): Promise<void> {
  const startedAt = performance.now();
  let deadlineFired = false;
  let responseReceived = false;
  let status: number | null = null;
  let rangeContractValid: boolean | null = null;
  let bodyPhase: 'not-started' | 'waiting-for-byte-or-eof' = 'not-started';
  let networkCode: string | null = null;
  const controller = new AbortController();
  const cancel = (): void => controller.abort(clientSignal.reason);
  clientSignal.addEventListener('abort', cancel, { once: true });
  if (clientSignal.aborted) cancel();
  const timeout = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, timeoutMs);
  try {
    await proveForwardedRange(
      upstreamUrl,
      async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Connection', 'close');
        let response: Response;
        try {
          response = await fetch(input, { ...init, headers });
        } catch (error) {
          try {
            const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
            const code = candidate?.cause?.code ?? candidate?.code;
            if (
              typeof code === 'string' &&
              [
                'ECONNREFUSED',
                'ECONNRESET',
                'ETIMEDOUT',
                'EPIPE',
                'UND_ERR_SOCKET',
                'UND_ERR_CONNECT_TIMEOUT',
                'UND_ERR_HEADERS_TIMEOUT',
                'UND_ERR_BODY_TIMEOUT',
              ].includes(code)
            ) {
              networkCode = code;
            }
          } catch {}
          throw error;
        }
        responseReceived = true;
        status = response.status;
        const range = /^bytes 0-0\/([1-9]\d*)$/u.exec(response.headers.get('content-range') ?? '');
        rangeContractValid =
          response.status === 206 &&
          response.headers.get('accept-ranges') === 'bytes' &&
          range !== null &&
          Number.isSafeInteger(Number(range[1])) &&
          (!response.headers.has('content-length') ||
            response.headers.get('content-length') === '1') &&
          response.body !== null;
        if (rangeContractValid) bodyPhase = 'waiting-for-byte-or-eof';
        return response;
      },
      controller.signal
    );
  } catch (error) {
    console.warn(
      '[remote-genomics] confirmation failed:',
      JSON.stringify({
        elapsedMs: Math.round(performance.now() - startedAt),
        timeoutMs,
        deadlineFired,
        clientAborted: clientSignal.aborted,
        responseReceived,
        status,
        rangeContractValid,
        bodyPhase,
        category:
          error instanceof RemoteGenomicsError && error.code === 'source-changed'
            ? 'source-changed'
            : clientSignal.aborted
              ? 'client-cancelled'
              : deadlineFired
                ? 'deadline'
                : !responseReceived
                  ? 'network'
                  : !rangeContractValid
                    ? 'range-contract'
                    : 'body',
        networkCode,
        ...context(),
      })
    );
    throw error;
  } finally {
    clearTimeout(timeout);
    clientSignal.removeEventListener('abort', cancel);
  }
}

function probeLoopbackHealth(upstreamUrl: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve();
    };
    const request = requestHttp(upstreamUrl, { method: 'HEAD' }, (response) => {
      response.resume();
      if (response.statusCode === 412) {
        finish(new RemoteGenomicsError('source-changed', REMOTE_SOURCE_CHANGED_MESSAGE));
        return;
      }
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        finish(new Error('The SSH range helper health check returned an invalid response.'));
        return;
      }
      response.once('aborted', () =>
        finish(new Error('The SSH range helper health check ended early.'))
      );
      response.once('error', finish);
      response.once('end', () => finish());
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('The SSH range helper health check timed out.'));
    });
    request.once('error', finish);
    request.end();
  });
}

function proxyLoopbackRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  upstreamUrl: string,
  timeoutMs: number,
  clientSignal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let upstreamResponse: IncomingMessage | null = null;
    let upstreamTimedOut = false;
    let upstreamTimeoutState = 'none';
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clientSignal.removeEventListener('abort', onClientCancelled);
      upstreamResponse?.off('pause', onUpstreamPaused);
      upstreamResponse?.off('resume', onUpstreamResumed);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onClientCancelled = (): void => {
      upstreamResponse?.destroy();
      upstream.destroy();
      finish(new GatewayClientCancelledError());
    };
    const onUpstreamPaused = (): void => {
      if (outgoing.writableNeedDrain) upstream.setTimeout(0);
    };
    const onUpstreamResumed = (): void => {
      upstream.setTimeout(timeoutMs);
    };
    const upstream = requestHttp(
      upstreamUrl,
      {
        method: incoming.method,
        headers: proxyHeaders(incoming.headers),
      },
      (response) => {
        upstreamResponse = response;
        if (response.statusCode === 412) {
          response.resume();
          finish(new RemoteGenomicsError('source-changed', REMOTE_SOURCE_CHANGED_MESSAGE));
          return;
        }
        const headers: Record<string, string | string[]> = {
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
        };
        for (const name of [
          'accept-ranges',
          'cache-control',
          'content-length',
          'content-range',
          'content-type',
          'etag',
          'last-modified',
        ]) {
          const value = response.headers[name];
          if (value !== undefined) headers[name] = value;
        }
        if (clientSignal.aborted || outgoing.destroyed) {
          onClientCancelled();
          return;
        }
        outgoing.writeHead(response.statusCode ?? 502, headers);
        response.once('aborted', () => {
          if (clientSignal.aborted || outgoing.destroyed || incoming.aborted) {
            finish(new GatewayClientCancelledError());
          } else {
            finish(
              new Error(
                `The SSH range response ended early (${incoming.method ?? 'unknown'} ` +
                  `range=${String(incoming.headers.range ?? 'none')} ` +
                  `status=${response.statusCode ?? 'unknown'} ` +
                  `length=${String(response.headers['content-length'] ?? 'unknown')} ` +
                  `upstreamComplete=${response.complete} ` +
                  `upstreamTimedOut=${upstreamTimedOut} upstreamPaused=${response.isPaused()} ` +
                  `timeoutState=${upstreamTimeoutState} ` +
                  `downstreamNeedDrain=${outgoing.writableNeedDrain} ` +
                  `downstreamSocketDestroyed=${incoming.socket.destroyed} ` +
                  `downstreamBytesQueued=${outgoing.writableLength}).`
              )
            );
          }
        });
        response.once('error', (error) => {
          if (clientSignal.aborted || outgoing.destroyed || incoming.aborted) {
            finish(new GatewayClientCancelledError());
          } else {
            finish(error);
          }
        });
        response.once('end', () => finish());
        response.on('pause', onUpstreamPaused);
        response.on('resume', onUpstreamResumed);
        response.pipe(outgoing);
      }
    );
    upstream.setTimeout(timeoutMs, () => {
      upstreamTimedOut = true;
      upstreamTimeoutState = JSON.stringify({
        paused: upstreamResponse?.isPaused() ?? null,
        needDrain: outgoing.writableNeedDrain,
        socketDestroyed: incoming.socket.destroyed,
        writableBytes: outgoing.writableLength,
      });
      upstream.destroy(new Error('The SSH range transport stopped responding.'));
    });
    upstream.once('error', (error) => {
      if (clientSignal.aborted) finish(new GatewayClientCancelledError());
      else finish(error);
    });
    clientSignal.addEventListener('abort', onClientCancelled, { once: true });
    if (clientSignal.aborted) {
      onClientCancelled();
      return;
    }
    upstream.end();
  });
}

function gatewayClientLifetime(
  request: IncomingMessage,
  response: ServerResponse
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const cancel = (): void => {
    if (response.writableFinished || controller.signal.aborted) return;
    controller.abort(new GatewayClientCancelledError());
  };
  request.once('aborted', cancel);
  response.once('error', cancel);
  response.once('close', cancel);
  return {
    signal: controller.signal,
    dispose: () => {
      request.off('aborted', cancel);
      response.off('error', cancel);
      response.off('close', cancel);
    },
  };
}

function raceClientCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new GatewayClientCancelledError());
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => reject(new GatewayClientCancelledError());
    signal.addEventListener('abort', cancelled, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', cancelled);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', cancelled);
        reject(error);
      }
    );
  });
}

export const remoteGenomicsRuntime = new RemoteGenomicsRuntime(remoteGenomicsSupervisor);
