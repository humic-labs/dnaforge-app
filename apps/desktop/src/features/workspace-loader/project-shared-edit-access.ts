import { platform } from '../../platform';
import type { WorkspaceSyncStatus } from '../../shared/cloud-sync-status';

export type ProjectSharedEditAccess =
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; role: WorkspaceSyncStatus['accessRole'] };

export function projectSharedEditAccess(status: WorkspaceSyncStatus): ProjectSharedEditAccess {
  return { kind: 'ready', role: status.accessRole };
}

export async function readProjectSharedEditAccess(
  repoUuid: string
): Promise<ProjectSharedEditAccess> {
  try {
    const status = await platform().cloudSync.getStatus(repoUuid);
    return status.workspaceUuid === repoUuid
      ? projectSharedEditAccess(status)
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

interface Subscription {
  value: ProjectSharedEditAccess;
  listeners: Set<(access: ProjectSharedEditAccess) => void>;
  unsubscribe: () => void;
  sequence: number | null;
}

const subscriptions = new Map<string, Subscription>();

export function currentProjectSharedEditAccess(
  repoUuid: string
): ProjectSharedEditAccess | undefined {
  return subscriptions.get(repoUuid)?.value;
}

export function subscribeProjectSharedEditAccess(
  repoUuid: string,
  listener: (access: ProjectSharedEditAccess) => void
): () => void {
  let subscription = subscriptions.get(repoUuid);
  if (!subscription) {
    const created: Subscription = {
      value: { kind: 'checking' },
      listeners: new Set(),
      unsubscribe: () => {},
      sequence: null,
    };
    subscriptions.set(repoUuid, created);
    const publish = (value: ProjectSharedEditAccess) => {
      if (subscriptions.get(repoUuid) !== created) return;
      created.value = value;
      for (const notify of created.listeners) notify(value);
    };
    try {
      created.unsubscribe = platform().cloudSync.subscribeStatus(repoUuid, (event) => {
        if (event.workspaceUuid !== repoUuid || event.status.workspaceUuid !== repoUuid) return;
        if (created.sequence !== null && event.sequence <= created.sequence) return;
        created.sequence = event.sequence;
        publish(projectSharedEditAccess(event.status));
      });
      void readProjectSharedEditAccess(repoUuid).then((value) => {
        if (created.sequence === null) publish(value);
      });
    } catch {
      publish({ kind: 'unavailable' });
    }
    subscription = created;
  }
  const current = subscription;
  current.listeners.add(listener);
  listener(current.value);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size !== 0 || subscriptions.get(repoUuid) !== current) return;
    subscriptions.delete(repoUuid);
    current.unsubscribe();
  };
}
