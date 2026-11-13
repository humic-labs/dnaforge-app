export { alignmentSessionOutputSchema } from './document-edit-output-schemas';
import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { useVerificationStore } from '../../alignment-manager/public/store';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import { contentFingerprint } from '../../../db/entity-substrate/adapter';
import { loadSequenceDocumentBiologyFile, resolveMultiRootPath } from './path-utils';

const session = { sessionId: z.string().min(1) };
const track = { ...session, trackId: z.string().min(1) };
export const alignmentSessionSchema = z
  .object({
    documentId: z.string().min(1),
    expectedRevision: z.string().optional(),
    operation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('inspect'),
          sessionId: z.string().optional(),
          trackId: z.string().optional(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
      z
        .object({
          kind: z.literal('create'),
          name: z.string().trim().min(1).max(200),
          mode: z.enum(['one-per-clone', 'multi-per-clone']),
        })
        .strict(),
      z
        .object({
          kind: z.literal('rename-session'),
          ...session,
          name: z.string().trim().min(1).max(200),
        })
        .strict(),
      z.object({ kind: z.literal('archive-session'), ...session, archived: z.boolean() }).strict(),
      z.object({ kind: z.literal('remove-session'), ...session }).strict(),
      z.object({ kind: z.literal('activate-session'), sessionId: z.string().nullable() }).strict(),
      z
        .object({
          kind: z.literal('align-queries'),
          ...session,
          queryPaths: z.array(z.string().min(1)).min(1).max(100),
        })
        .strict(),
      z
        .object({
          kind: z.literal('rename-track'),
          ...track,
          label: z.string().trim().min(1).max(200),
        })
        .strict(),
      z.object({ kind: z.literal('remove-track'), ...track }).strict(),
      z
        .object({
          kind: z.literal('set-status'),
          ...track,
          status: z.enum(['pass', 'variants', 'fail']).nullable(),
          reason: z.string().max(2000).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('set-checked'),
          ...track,
          mutationId: z.string().min(1),
          checked: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('configure-view'),
          ...session,
          viewMode: z.enum(['single', 'stacked']).optional(),
          selectedTrackId: z.string().nullable().optional(),
          alignmentVisible: z.boolean().optional(),
          hiddenTrackIds: z.array(z.string()).max(1000).optional(),
        })
        .strict(),
    ]),
  })
  .strict();
function revision(documentId: string) {
  const state = useVerificationStore.getState();
  return contentFingerprint(
    JSON.stringify({
      reference: state.verificationState[documentId] ?? null,
      checksum: state.referenceFileChecksums[documentId] ?? null,
      stale: state.staleReferences[documentId] ?? false,
      views: Object.entries(state.sessionViewPreferences).filter(([key]) =>
        key.startsWith(`${documentId}::`)
      ),
    })
  );
}
export function createAlignmentSessionTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Inspect and curate alignment verification sessions through the human Alignment Manager: create, rename, archive/restore/remove sessions, align query files, rename/remove tracks, override status, select mutations, and configure visibility. Inspect supplies exact IDs and a revision required for edits. Saves native alignment history; computation uses the existing durable session job owner.',
    inputSchema: alignmentSessionSchema,
    execute: async ({ documentId: inputId, expectedRevision, operation }) => {
      let changed: boolean | 'unknown' = false;
      const fail = (code: string, error: string) =>
        toolFailure({ code, error, retriable: false, stateChanged: changed, partialEffects: [] });
      try {
        const loaded = await loadSequenceDocumentBiologyFile(inputId, folders);
        const { documentId, sourcePath } = loaded;
        const folder = findContainingPathBoundary(folders, sourcePath);
        if (!folder)
          return fail('OUTSIDE_WORKSPACE', 'The reference is outside the mounted workspace.');
        if (folder.pinned && operation.kind !== 'inspect')
          return fail('READ_ONLY_REFERENCE', 'Import an editable reference first.');
        let store = useVerificationStore.getState();
        store.registerReferenceSource(documentId, sourcePath);
        if (!store.getVerificationState(documentId)) await store.loadSidecar(documentId);
        store = useVerificationStore.getState();
        const state = store.getVerificationState(documentId);
        const currentRevision = revision(documentId);
        const selected =
          'sessionId' in operation && operation.sessionId
            ? state?.sessions.find((session) => session.id === operation.sessionId)
            : undefined;
        if ('sessionId' in operation && operation.sessionId && !selected)
          return fail('SESSION_NOT_FOUND', 'Inspect this reference for its current session IDs.');
        const selectedTrack =
          'trackId' in operation && operation.trackId
            ? selected?.tracks.find((track) => track.id === operation.trackId)
            : undefined;
        if ('trackId' in operation && operation.trackId && !selectedTrack)
          return fail('TRACK_NOT_FOUND', 'Inspect the session for its track IDs.');
        if (operation.kind === 'inspect') {
          const sessions = selected
            ? [selected]
            : (state?.sessions ?? []).slice(operation.offset, operation.offset + operation.limit);
          return toolSuccess({
            documentId,
            revision: currentRevision,
            stale: Boolean(store.staleReferences[documentId]),
            activeSessionId: state?.activeSessionId ?? null,
            sessions: sessions.map((session) => ({
              id: session.id,
              name: session.name,
              mode: session.mode,
              archived: Boolean(session.archived),
              operation: session.alignmentOperation
                ? { id: session.alignmentOperation.id, status: session.alignmentOperation.status }
                : null,
              view: store.getSessionViewPreferences(documentId, session.id),
              tracks: session.tracks
                .slice(
                  selected ? operation.offset : 0,
                  (selected ? operation.offset : 0) + operation.limit
                )
                .map((track) => ({
                  id: track.id,
                  label: track.label,
                  status: track.userStatus ?? track.status,
                  reason: track.userOverrideReason,
                  mutationCount: track.mutations.length,
                  checkedMutations: track.checkedMutations ?? [],
                })),
              trackCount: session.tracks.length,
            })),
            total: state?.sessions.length ?? 0,
            mutations: selectedTrack?.mutations.slice(
              operation.offset,
              operation.offset + operation.limit
            ),
            mutationCount: selectedTrack?.mutations.length,
            nextOffset:
              operation.offset + operation.limit <
              (selectedTrack?.mutations.length ??
                selected?.tracks.length ??
                state?.sessions.length ??
                0)
                ? operation.offset + operation.limit
                : null,
          });
        }
        if (currentRevision !== expectedRevision)
          return fail('STALE_ALIGNMENT', 'Inspect the alignment state again before editing it.');
        if (
          operation.kind === 'set-checked' &&
          !selectedTrack?.mutations.some((mutation) => mutation.id === operation.mutationId)
        )
          return fail('MUTATION_NOT_FOUND', 'That mutation is not in the current track.');
        if (operation.kind === 'configure-view') {
          const ids = new Set(selected!.tracks.map((track) => track.id));
          if (
            (operation.selectedTrackId && !ids.has(operation.selectedTrackId)) ||
            operation.hiddenTrackIds?.some((id) => !ids.has(id))
          )
            return fail('TRACK_NOT_FOUND', 'View preferences must name tracks in this session.');
        }
        const queryPaths =
          operation.kind === 'align-queries'
            ? operation.queryPaths.map((path) => resolveMultiRootPath(folders, path).absolutePath)
            : [];
        changed = 'unknown';
        let createdSessionId: string | undefined;
        switch (operation.kind) {
          case 'create':
            createdSessionId = store.createSession(documentId, {
              name: operation.name,
              mode: operation.mode,
              queryPaths: [],
            });
            break;
          case 'rename-session':
            store.renameSession(documentId, operation.sessionId, operation.name);
            break;
          case 'archive-session':
            (operation.archived ? store.archiveSession : store.unarchiveSession)(
              documentId,
              operation.sessionId
            );
            break;
          case 'remove-session':
            await store.removeSession(documentId, operation.sessionId);
            break;
          case 'activate-session':
            store.setActiveSession(documentId, operation.sessionId);
            break;
          case 'rename-track':
            store.renameTrack(documentId, operation.sessionId, operation.trackId, operation.label);
            break;
          case 'remove-track':
            store.removeTrack(documentId, operation.sessionId, operation.trackId);
            break;
          case 'set-status':
            store.overrideTrackStatus(
              documentId,
              operation.sessionId,
              operation.trackId,
              operation.status,
              operation.reason
            );
            break;
          case 'set-checked':
            if (
              (selectedTrack!.checkedMutations ?? []).includes(operation.mutationId) !==
              operation.checked
            )
              store.toggleMutationChecked(
                documentId,
                operation.sessionId,
                operation.trackId,
                operation.mutationId
              );
            break;
          case 'configure-view': {
            const { kind: _, sessionId, ...prefs } = operation;
            store.setSessionViewPreferences(documentId, sessionId, prefs);
            break;
          }
          case 'align-queries': {
            await store.runSessionAlignments(documentId, operation.sessionId, queryPaths);
            break;
          }
        }
        changed = revision(documentId) !== currentRevision;
        await useVerificationStore
          .getState()
          .saveSidecar(documentId, { throwOnError: true, preserveStaleChecksum: true });
        return toolSuccess({
          documentId,
          revision: revision(documentId),
          saved: true,
          sessionId:
            createdSessionId ?? ('sessionId' in operation ? operation.sessionId : undefined),
        });
      } catch (error) {
        return fail(
          'ALIGNMENT_OPERATION_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
}
