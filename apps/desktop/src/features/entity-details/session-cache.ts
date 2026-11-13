import { useSyncExternalStore, useEffect } from 'react';
import { loadEntityDetails } from './factory';
import { EntityDetailsSession } from './session';
import type { EntityDetailsTarget } from './types';
import { getLimsEntityHistory } from '../lims/public/operations';
import {
  emitLimsRegistrationChanged,
  emitLimsRegistryChanged,
  subscribeLimsRegistrationChanged,
  subscribeLimsRegistryChanged,
} from '../lims/public/events';

import { sessions } from './editing-sessions';
export { peekEntityDetailsSession, findUnsettledEntityDetailsSession } from './editing-sessions';
let subscribed = false;

export function getEntityDetailsSession(target: EntityDetailsTarget): EntityDetailsSession {
  const current = sessions.get(target.entityId);
  if (current) return current;
  const session = new EntityDetailsSession(target, {
    load: loadEntityDetails,
    history: (entityId) => getLimsEntityHistory({ entityId }),
    changed: (entityId) => {
      emitLimsRegistrationChanged({ entityId, documentId: entityId });
      emitLimsRegistryChanged();
    },
  });
  sessions.set(target.entityId, session);
  if (!subscribed) {
    subscribed = true;
    subscribeLimsRegistrationChanged((detail) => {
      for (const [id, candidate] of sessions) {
        if (
          (!detail.entityId && !detail.documentId) ||
          detail.entityId === id ||
          detail.documentId === id
        )
          void candidate.load();
      }
    });
    subscribeLimsRegistryChanged(() => {
      for (const candidate of sessions.values()) void candidate.loadHistory();
    });
  }
  return session;
}

const subscribeEmpty = () => () => {};
const snapshotEmpty = () => null;

export function useOptionalEntityDetailsSession(target: EntityDetailsTarget | null) {
  const session = target ? getEntityDetailsSession(target) : null;
  const state = useSyncExternalStore(
    session?.subscribe ?? subscribeEmpty,
    session?.getSnapshot ?? snapshotEmpty
  );
  useEffect(() => {
    if (!session) return;
    if (!session.getSnapshot().definition) void session.load();
    return () => {
      queueMicrotask(() => {
        if (session.dispose()) sessions.delete(session.target.entityId);
      });
    };
  }, [session]);
  return { session, state };
}

export function useEntityDetailsSession(target: EntityDetailsTarget) {
  const result = useOptionalEntityDetailsSession(target);
  if (!result.session || !result.state) throw new Error('The metadata target is unavailable.');
  return { session: result.session, state: result.state };
}
