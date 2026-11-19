import type { EntityDetailsSession } from './session';

export const sessions = new Map<string, EntityDetailsSession>();

export function peekEntityDetailsSession(entityId: string): EntityDetailsSession | undefined {
  return sessions.get(entityId);
}

export function sequenceMetadataSession(documentId: string): EntityDetailsSession | undefined {
  return (
    sessions.get(documentId) ??
    [...sessions.values()].find(
      (session) =>
        session.target.sequenceFile?.documentId === documentId ||
        session.target.managedSequence?.packageId === documentId
    )
  );
}

export function findUnsettledEntityDetailsSession(
  entityIds: readonly string[],
  paths: readonly string[]
): EntityDetailsSession | undefined {
  return [...sessions.values()].find((session) => {
    if (!session.dirty && !session.getSnapshot().saving && !session.getSnapshot().completionPending)
      return false;
    const record = session.getSnapshot().definition?.record;
    return (
      entityIds.includes(session.target.entityId) ||
      Boolean(
        session.target.sequenceFile?.documentId &&
        entityIds.includes(session.target.sequenceFile.documentId)
      ) ||
      Boolean(record?.path && paths.includes(record.path))
    );
  });
}
