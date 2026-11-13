import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

import { handleGroup, mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import type {
  RemoteAlignmentConnectRequestV1,
  RemoteAlignmentMaterializationV1,
  RemoteSignalConnectRequestV1,
  RemoteSignalMaterializationV1,
  RemoteExplorerSessionV1,
} from '../../shared/remote-genomics-ipc';
import { getDb } from './database';
import {
  findRemoteEndpointProfileById,
  findRemoteEndpointProfileByTarget,
  listRemoteEndpointProfiles,
  renameRemoteEndpointProfile,
  forgetRemoteEndpointProfile,
  recordRemoteEndpointFailure,
  recordRemoteEndpointSuccess,
} from '../remote-endpoint-registry';
import {
  RemoteGenomicsError,
  validateRemoteAlignmentRequest,
  validateRemoteSignalRequest,
} from '../remote-genomics-supervisor';
import { remoteGenomicsRuntime, type RemoteGenomicsRuntime } from '../remote-genomics-runtime';
import { remoteEndpointExplorer, type RemoteEndpointExplorer } from '../remote-endpoint-explorer';
import { remoteSshPromptBroker } from '../remote-ssh-prompt-broker';
import { remoteSshConnectionHandoff } from '../remote-ssh-connection-handoff';
import { remoteGenomicsContract } from '../../shared/ipc/remote-genomics.contract';

export function registerRemoteGenomicsIpcHandlers(
  dependencies: {
    readonly database?: () => Database.Database;
    readonly supervisor?: Pick<
      RemoteGenomicsRuntime,
      | 'cancelConnect'
      | 'connect'
      | 'connectSignal'
      | 'disconnect'
      | 'listStatuses'
      | 'retryEndpoint'
      | 'subscribe'
    >;
    readonly explorer?: Pick<
      RemoteEndpointExplorer,
      | 'open'
      | 'list'
      | 'close'
      | 'closeOwner'
      | 'cancelOpen'
      | 'retainConnection'
      | 'subscribeClosed'
    >;
  } = {}
): void {
  const database = dependencies.database ?? getDb;
  const supervisor = dependencies.supervisor ?? remoteGenomicsRuntime;
  const explorer = dependencies.explorer ?? remoteEndpointExplorer;
  const statusSubscriptions = new Map<string, () => void>();
  type Owner = { readonly contents: WebContents; generation: number; readonly leases: Set<string> };
  const owners = new Map<number, Owner>();
  type AttemptKind = 'explorer' | 'genomics';
  const attempts = new Map<
    string,
    {
      readonly ownerId: number;
      readonly generation: number;
      readonly kind: AttemptKind;
      cancelled: boolean;
    }
  >();

  const cancelAttempt = (requestId: string, ownerId: number, kind: AttemptKind): boolean => {
    const attempt = attempts.get(requestId);
    if (!attempt || attempt.ownerId !== ownerId || attempt.kind !== kind) return false;
    attempt.cancelled = true;
    if (kind === 'explorer') explorer.cancelOpen(requestId, ownerId);
    else supervisor.cancelConnect(requestId);
    void remoteSshPromptBroker.finish(requestId).catch(() => undefined);
    return true;
  };
  const bindOwner = (contents: WebContents): Owner => {
    const existing = owners.get(contents.id);
    if (existing) return existing;
    const owner: Owner = { contents, generation: 0, leases: new Set() };
    owners.set(contents.id, owner);
    const releaseGeneration = (): void => {
      owner.generation += 1;
      for (const [id, attempt] of attempts) {
        if (attempt.ownerId === contents.id) cancelAttempt(id, contents.id, attempt.kind);
      }
      const leases = [...owner.leases];
      owner.leases.clear();
      for (const lease of leases) void supervisor.disconnect(lease).catch(() => undefined);
      void explorer.closeOwner(contents.id).catch(() => undefined);
      for (const [key, unsubscribe] of statusSubscriptions) {
        if (key.startsWith(`${contents.id}:`)) unsubscribe();
      }
    };
    contents.on('render-process-gone', releaseGeneration);
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) releaseGeneration();
    });
    contents.once('destroyed', () => {
      releaseGeneration();
      owners.delete(contents.id);
    });
    return owner;
  };
  explorer.subscribeClosed(({ ownerId, ...closed }) => {
    const owner = owners.get(ownerId);
    if (owner && !owner.contents.isDestroyed()) {
      sendRendererIpc(owner.contents, 'remoteGenomics:explorerClosed', closed);
    }
  });
  const beginAttempt = (requestId: string, owner: WebContents, kind: AttemptKind) => {
    if (
      typeof requestId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(requestId) ||
      attempts.has(requestId)
    ) {
      throw new RemoteGenomicsError(
        'invalid-request',
        'The SSH request ID is invalid or already in use.'
      );
    }
    const state = bindOwner(owner);
    const attempt = {
      ownerId: owner.id,
      generation: state.generation,
      kind,
      cancelled: owner.isDestroyed(),
    };
    attempts.set(requestId, attempt);
    return attempt;
  };
  const assertActive = (attempt: {
    cancelled: boolean;
    ownerId: number;
    generation: number;
  }): void => {
    const owner = owners.get(attempt.ownerId);
    if (
      attempt.cancelled ||
      !owner ||
      owner.contents.isDestroyed() ||
      owner.generation !== attempt.generation
    )
      throw new RemoteGenomicsError('helper-failed', 'The SSH connection attempt was cancelled.');
  };
  const connectOwnedSource = async <
    Request extends RemoteAlignmentConnectRequestV1 | RemoteSignalConnectRequestV1,
    Result extends RemoteAlignmentMaterializationV1 | RemoteSignalMaterializationV1,
  >(
    event: { readonly sender: WebContents },
    validated: Request,
    acquire: (request: Request) => Promise<Result>
  ): Promise<Result> => {
    const admitted = { ...validated, requestId: validated.requestId ?? randomUUID() };
    const db = database();
    const previous = findRemoteEndpointProfileByTarget(db, admitted.target);
    const endpointIdentity = admitted.endpointId
      ? findRemoteEndpointProfileById(db, admitted.endpointId)
      : null;
    if (endpointIdentity && endpointIdentity.target !== admitted.target) {
      throw new RemoteGenomicsError(
        'invalid-request',
        'The saved remote endpoint identity no longer matches this SSH target.'
      );
    }
    let connectedSessionId: string | null = null;
    const attempt = beginAttempt(admitted.requestId, event.sender, 'genomics');
    try {
      assertActive(attempt);
      if (admitted.explorerSessionId && admitted.requestId) {
        const connection = explorer.retainConnection(
          admitted.explorerSessionId,
          admitted.target,
          event.sender.id
        );
        if (connection) {
          try {
            remoteSshConnectionHandoff.offer(admitted.requestId, connection);
          } catch (error) {
            await connection.release();
            throw error;
          }
        }
      }
      const materialization = await acquire({
        ...admitted,
        endpointId: previous?.endpointId ?? admitted.endpointId,
        displayName: admitted.displayName ?? previous?.displayName,
      });
      connectedSessionId = materialization.sessionId;
      assertActive(attempt);
      const endpoint = recordRemoteEndpointSuccess(db, {
        ...materialization.endpoint,
        displayName:
          admitted.displayName ??
          findRemoteEndpointProfileByTarget(db, admitted.target)?.displayName ??
          materialization.endpoint.displayName,
      });
      owners.get(event.sender.id)!.leases.add(materialization.sessionId);
      return { ...materialization, endpoint };
    } catch (error) {
      if (connectedSessionId) await supervisor.disconnect(connectedSessionId);
      if (!attempt.cancelled && error instanceof RemoteGenomicsError) {
        recordRemoteEndpointFailure(db, admitted.target, {
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    } finally {
      if (admitted.requestId) {
        await remoteSshConnectionHandoff.discard(admitted.requestId);
        await remoteSshPromptBroker.finish(admitted.requestId);
        attempts.delete(admitted.requestId);
      }
    }
  };
  mainIpc.handle('remoteGenomics:subscribeStatus', (event, subscriptionId: string) => {
    bindOwner(event.sender);
    const id = requireSubscriptionId(subscriptionId);
    const subscriptionKey = `${event.sender.id}:${id}`;
    statusSubscriptions.get(subscriptionKey)?.();
    const unsubscribeRuntime = supervisor.subscribe((statusEvent) => {
      if (event.sender.isDestroyed()) return;
      sendRendererIpc(event.sender, 'remoteGenomics:statusChanged', {
        subscriptionId: id,
        event: statusEvent,
      });
    });
    const cleanup = (): void => {
      unsubscribeRuntime();
      event.sender.off('destroyed', cleanup);
      if (statusSubscriptions.get(subscriptionKey) === cleanup) {
        statusSubscriptions.delete(subscriptionKey);
      }
    };
    statusSubscriptions.set(subscriptionKey, cleanup);
    event.sender.once('destroyed', cleanup);
    return { subscriptionId: id, statuses: supervisor.listStatuses() };
  });
  mainIpc.handle('remoteGenomics:unsubscribeStatus', (event, subscriptionId: string) => {
    const id = requireSubscriptionId(subscriptionId);
    statusSubscriptions.get(`${event.sender.id}:${id}`)?.();
  });
  handleGroup(remoteGenomicsContract, {
    openExplorer: async (event, request: { requestId: string; target: string }) => {
      const attempt = beginAttempt(request.requestId, event.sender, 'explorer');
      let descriptor: RemoteExplorerSessionV1 | null = null;
      try {
        assertActive(attempt);
        descriptor = await explorer.open(request, event.sender.id);
        assertActive(attempt);
        const db = database();
        const previous = findRemoteEndpointProfileByTarget(db, descriptor.target);
        recordRemoteEndpointSuccess(db, {
          endpointId: previous?.endpointId ?? randomUUID(),
          displayName: previous?.displayName ?? descriptor.target,
          target: descriptor.target,
          lastConnectedAt: descriptor.connectedAt,
          observedPlatform: descriptor.platform,
          lastFailure: null,
        });
        return descriptor;
      } catch (error) {
        if (descriptor) await explorer.close(descriptor.sessionId, event.sender.id);
        throw error;
      } finally {
        await remoteSshPromptBroker.finish(request.requestId);
        attempts.delete(request.requestId);
      }
    },
    listRemoteDirectory: (event, sessionId: string, path: string) =>
      explorer.list(sessionId, path, event.sender.id),
    closeExplorer: (event, sessionId: string) => explorer.close(sessionId, event.sender.id),
    cancelExplorerOpen: (event, requestId: string) => {
      return cancelAttempt(requestId, event.sender.id, 'explorer');
    },
    respondAuthPrompt: (event, promptId: string, answer: string | null) =>
      remoteSshPromptBroker.respond(promptId, answer, event.sender.id),
    listEndpoints: () => listRemoteEndpointProfiles(database()),
    renameEndpoint: (_event, endpointId: string, displayName: string) =>
      renameRemoteEndpointProfile(database(), endpointId, displayName),
    forgetEndpoint: (_event, endpointId: string) =>
      forgetRemoteEndpointProfile(database(), endpointId),
    connectAlignment: (event, request: RemoteAlignmentConnectRequestV1) =>
      connectOwnedSource(event, validateRemoteAlignmentRequest(request), (input) =>
        supervisor.connect(input)
      ),
    connectSignal: (event, request: RemoteSignalConnectRequestV1) =>
      connectOwnedSource(event, validateRemoteSignalRequest(request), (input) =>
        supervisor.connectSignal(input)
      ),
    disconnectSession: async (event, sessionId: string) => {
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return;
      if (!owners.get(event.sender.id)?.leases.delete(sessionId)) return;
      await supervisor.disconnect(sessionId);
    },
    cancelConnect: (event, requestId: string) => {
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(requestId)) return false;
      return cancelAttempt(requestId, event.sender.id, 'genomics');
    },
    listStatuses: () => supervisor.listStatuses(),
    retryEndpoint: (_event, endpointIdOrTarget: string) => {
      if (
        typeof endpointIdOrTarget !== 'string' ||
        endpointIdOrTarget.trim().length === 0 ||
        endpointIdOrTarget.length > 255
      ) {
        return false;
      }
      return supervisor.retryEndpoint(endpointIdOrTarget.trim());
    },
  });
}

function requireSubscriptionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/u.test(value)) {
    throw new Error('Remote genomics subscription ID is invalid.');
  }
  return value;
}
