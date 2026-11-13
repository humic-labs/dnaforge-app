import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const WORKSPACE_SYNC_ENABLEMENT_PREFIX = '_workspace_sync_enablement_v1:';

const identitySchema = z
  .object({
    workspaceUuid: z.string().min(1).max(128),
    ownerAccountId: z.string().min(1).max(128),
    ownerOrgId: z.string().min(1).max(128).nullable(),
    remoteWorkspaceId: z.string().uuid(),
  })
  .strict();
const episodeSchema = identitySchema
  .omit({ workspaceUuid: true })
  .extend({
    operationId: z.string().uuid(),
    parentOperationId: z.string().uuid().nullable(),
    startedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const enablementSchema = z
  .object({
    format: z.literal('workspace-sync-enablement'),
    schemaVersion: z.literal(1),
    workspaceUuid: identitySchema.shape.workspaceUuid,
    episodes: z.array(episodeSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const owners = new Map<string, string>();
    for (const episode of value.episodes) {
      const owner = JSON.stringify([episode.ownerAccountId, episode.ownerOrgId]);
      if (ids.has(episode.operationId) || episode.parentOperationId !== (owners.get(owner) ?? null))
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid enablement lineage.' });
      ids.add(episode.operationId);
      owners.set(owner, episode.operationId);
    }
  });

export type WorkspaceSyncEnablementIdentity = z.infer<typeof identitySchema>;
export type WorkspaceSyncEnablementEpisode = z.infer<typeof episodeSchema>;
export type WorkspaceSyncEnablement = z.infer<typeof enablementSchema>;

export function readWorkspaceSyncEnablement(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceSyncEnablement | null {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(WORKSPACE_SYNC_ENABLEMENT_PREFIX + workspaceUuid);
  if (row === undefined) return null;
  const encoded = z.object({ value: z.string() }).parse(row);
  const value = enablementSchema.parse(JSON.parse(encoded.value));
  if (value.workspaceUuid !== workspaceUuid)
    throw new Error('Cloud backup enablement history belongs to a different project.');
  return value;
}

export function recordWorkspaceSyncEnablement(
  db: Database.Database,
  input: WorkspaceSyncEnablementIdentity
): WorkspaceSyncEnablementEpisode {
  if (!db.inTransaction)
    throw new Error('Cloud backup enablement must commit with its project binding.');
  const identity = identitySchema.parse(input);
  const previous = readWorkspaceSyncEnablement(db, identity.workspaceUuid);
  const parent = [...(previous?.episodes ?? [])]
    .reverse()
    .find(
      (episode) =>
        episode.ownerAccountId === identity.ownerAccountId &&
        episode.ownerOrgId === identity.ownerOrgId
    );
  const episode: WorkspaceSyncEnablementEpisode = {
    ownerAccountId: identity.ownerAccountId,
    ownerOrgId: identity.ownerOrgId,
    remoteWorkspaceId: identity.remoteWorkspaceId,
    operationId: randomUUID(),
    parentOperationId: parent?.operationId ?? null,
    startedAtMs: Date.now(),
  };
  const value: WorkspaceSyncEnablement = {
    format: 'workspace-sync-enablement',
    schemaVersion: 1,
    workspaceUuid: identity.workspaceUuid,
    episodes: [...(previous?.episodes ?? []), episode],
  };
  db.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(
    WORKSPACE_SYNC_ENABLEMENT_PREFIX + identity.workspaceUuid,
    JSON.stringify(value),
    episode.startedAtMs
  );
  return episode;
}
