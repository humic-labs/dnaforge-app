import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import { subscribeRegistryChanged } from '../../shared/registry-events';
import type { EntityDescriptor } from '../../shared/entity-discovery';

export interface ReferenceTypeLookup {
  entityId: string;
  projectId?: string | null;
  projectRoot?: string | null;
}

type Presentation = Pick<
  EntityDescriptor,
  'kindLabel' | 'iconKind' | 'registryKind' | 'namedTypeKey' | 'path' | 'iconContext'
>;
type Subscriber = (presentation: Presentation | null) => void;
type Batch = Map<string, Set<Subscriber>>;

const batches = new Map<string, Batch>();

function subscribe({ entityId, projectId, projectRoot }: ReferenceTypeLookup, receive: Subscriber) {
  const scope = {
    ...(projectId ? { projectId } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    includeArchived: true,
  };
  const key = JSON.stringify(scope);
  let batch = batches.get(key);
  if (!batch) {
    batch = new Map();
    batches.set(key, batch);
    const requests = batch;
    queueMicrotask(async () => {
      batches.delete(key);
      const ids = [...requests.keys()].filter((id) => requests.get(id)?.size);
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const chunk = ids.slice(offset, offset + 1000);
        try {
          const page = await platform().entityDiscovery.resolve({ ids: chunk, scope });
          for (const item of page.items) {
            const result = item.status === 'available' ? item.entity : null;
            requests.get(item.id)?.forEach((subscriber) => subscriber(result));
          }
        } catch {
          for (const id of chunk) requests.get(id)?.forEach((subscriber) => subscriber(null));
        }
      }
    });
  }
  let subscribers = batch.get(entityId);
  if (!subscribers) {
    subscribers = new Set();
    batch.set(entityId, subscribers);
  }
  subscribers.add(receive);
  return () => subscribers.delete(receive);
}

export function useReferenceEntityType(lookup?: ReferenceTypeLookup) {
  const entityId = lookup?.entityId;
  const projectId = lookup?.projectId;
  const projectRoot = lookup?.projectRoot;
  const key = JSON.stringify([entityId, projectId, projectRoot]);
  const [resolved, setResolved] = useState<{ key: string; type: Presentation | null }>();
  useEffect(() => {
    if (!entityId) return;
    let cancel: (() => void) | undefined;
    const refresh = () => {
      cancel?.();
      cancel = subscribe({ entityId, projectId, projectRoot }, (type) =>
        setResolved({ key, type })
      );
    };
    refresh();
    const unsubscribe = subscribeRegistryChanged(refresh);
    return () => {
      unsubscribe();
      cancel?.();
    };
  }, [entityId, projectId, projectRoot, key]);
  return resolved?.key === key ? resolved.type : null;
}
