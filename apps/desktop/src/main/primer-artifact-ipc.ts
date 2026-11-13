import type Database from 'better-sqlite3';
import { handleGroup } from '../shared/ipc-contract';
import { primerArtifactContract } from '../shared/ipc/primer-artifact.contract';
import type { PrimerArtifactRevisionStateRequest } from '../shared/primer-artifact-revision';
import type { RendererDatabaseLifecycleSender } from './workspace-sync-database-fence';
import { getActiveStoredSession } from './auth/session-store';
import {
  publishPrimerArtifactRevision,
  readPrimerArtifactRevisionStateInMain,
  resumePrimerArtifactPublication,
} from './primer-artifact-mutations';

type WithLimsLease = <T>(
  sender: RendererDatabaseLifecycleSender,
  input: unknown,
  operation: (db: Database.Database, runDatabase: <R>(work: () => R) => R) => Promise<T>,
  mutationToken?: string
) => Promise<T>;

type WithLimsReadContext = <T>(
  sender: RendererDatabaseLifecycleSender,
  operation: (db: Database.Database, runDatabase: <R>(work: () => R) => R) => Promise<T>
) => Promise<T>;

function checkedIdentity(value: PrimerArtifactRevisionStateRequest) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.entityId !== 'string' ||
    !value.entityId ||
    value.entityId.length > 512 ||
    (value.mutationToken !== undefined &&
      (typeof value.mutationToken !== 'string' || !value.mutationToken))
  )
    throw new Error('The saved primer identity or project edit token is invalid.');
  return { entityId: value.entityId, mutationToken: value.mutationToken };
}
const getActiveAccountId = async () => (await getActiveStoredSession())?.accountId ?? null;

export function registerPrimerArtifactIpcHandlers(
  withLease: WithLimsLease,
  withReadContext: WithLimsReadContext
): void {
  handleGroup(primerArtifactContract, {
    readPrimerArtifactRevisionState: (event, request) => {
      const identity = checkedIdentity(request);
      const read = (db: Database.Database, runDatabase: <R>(work: () => R) => R) =>
        readPrimerArtifactRevisionStateInMain({
          db,
          runDatabase,
          getActiveAccountId,
          entityId: identity.entityId,
        });
      if (!identity.mutationToken) return withReadContext(event.sender, read);
      return withLease(event.sender, { entityId: identity.entityId }, read, identity.mutationToken);
    },
    revisePrimerArtifact: (event, input) => {
      const identity = checkedIdentity(input);
      const { mutationToken, ...request } = input;
      return withLease(
        event.sender,
        { entityId: identity.entityId },
        (db, runDatabase) =>
          publishPrimerArtifactRevision({ db, runDatabase, getActiveAccountId, request }),
        mutationToken
      );
    },
    resumePrimerArtifactPublication: (event, request) => {
      const identity = checkedIdentity(request);
      return withLease(
        event.sender,
        { entityId: identity.entityId },
        (db, runDatabase) =>
          resumePrimerArtifactPublication({
            db,
            runDatabase,
            getActiveAccountId,
            entityId: identity.entityId,
            operationId: request.operationId,
          }),
        identity.mutationToken
      );
    },
  });
}
