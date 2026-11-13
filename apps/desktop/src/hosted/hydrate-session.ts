import type { WorkspaceSessionSnapshot } from '@waypoint/domain-services';
import type { JSONContent } from '@tiptap/core';
import { registerWorkspaceFile } from '../db/workspace-catalog';
import { useCanvasStore } from '../features/canvas/store';
import {
  catalogSequenceDocumentRef,
  resolveSequenceDocument,
  type ResolvedSequenceDocument,
} from '../features/sequence/sequence-document-repository';
import { sequenceDocumentKey } from '../shared/managed-sequence-document';
import { managedSequenceRepository } from '../features/sequence/managed-sequence-repository';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { hostedWorkspaceSessionController } from './controller';
import { hostedAbsolutePath, hostedWorkspaceRoot } from './paths';
import { hostedFileNameParts, hostedSnapshotFileMatchesHint } from './snapshot-file-match';

export { hostedSnapshotFileMatchesHint } from './snapshot-file-match';

const SEQUENCE_FILE_KINDS = new Set(['genbank', 'fasta', 'fastq', 'trace', 'geneious']);

function isNotebookMetaPath(path: string): boolean {
  return /(^|\/)\.forge\/notebook\.json$/u.test(path);
}

function isTiptapJsonContent(value: unknown): value is JSONContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== undefined && typeof candidate.type !== 'string') return false;
  if (candidate.text !== undefined && typeof candidate.text !== 'string') return false;
  if (
    candidate.content !== undefined &&
    (!Array.isArray(candidate.content) || !candidate.content.every(isTiptapJsonContent))
  ) {
    return false;
  }
  if (
    candidate.marks !== undefined &&
    (!Array.isArray(candidate.marks) ||
      !candidate.marks.every(
        (mark) =>
          Boolean(mark) &&
          typeof mark === 'object' &&
          !Array.isArray(mark) &&
          typeof (mark as Record<string, unknown>).type === 'string'
      ))
  ) {
    return false;
  }
  return true;
}

export async function hydrateHostedSnapshot(snapshot: WorkspaceSessionSnapshot): Promise<void> {
  const root = hostedWorkspaceRoot(snapshot.workspaceId);
  const registered: Array<{ path: string; entityId: string; fileName: string }> = [];
  for (const file of snapshot.files) {
    const fileKind = inferCatalogFileKind(file.path);
    if (!SEQUENCE_FILE_KINDS.has(fileKind)) continue;
    const fileName = hostedFileNameParts(file.path).base;
    const entity = await registerWorkspaceFile({
      path: hostedAbsolutePath(snapshot.workspaceId, file.path),
      name: fileName,
      entityType: 'sequence',
      fileKind,
      workspaceRoot: root,
      sizeBytes: file.sizeBytes,
      contentHash: file.contentSha256 ? `sha256:${file.contentSha256}` : null,
    });
    registered.push({ path: file.path, entityId: entity.id, fileName });
  }
  remapHostedCanvasTabs(registered);
  await hydrateHostedNotebooks(snapshot, root);
  const store = useWorkspaceStore.getState();
  store.bumpFileTreeRefresh();
  const first = snapshot.files[0];
  if (first) store.revealPath(hostedAbsolutePath(snapshot.workspaceId, first.path));
}

async function hydrateHostedNotebooks(
  snapshot: WorkspaceSessionSnapshot,
  root: string
): Promise<void> {
  const metas = snapshot.files.filter((file) => isNotebookMetaPath(file.path));
  if (metas.length === 0) return;
  const [{ withWorkspaceArtifactOpen }, { usePageStore }] = await Promise.all([
    import('../services/workspace-artifact-open'),
    import('../features/page/store'),
  ]);
  for (const file of metas) {
    const metaPath = hostedAbsolutePath(snapshot.workspaceId, file.path);
    await withWorkspaceArtifactOpen({
      path: metaPath,
      workspaceRoot: root,
      consume: async (resolved) => {
        if (resolved.artifact.kind !== 'notebook') return;
        if (!isTiptapJsonContent(resolved.artifact.content)) {
          throw new Error(`Hosted notebook content is invalid: ${file.path}`);
        }
        await usePageStore.getState().upsertPageFromArtifact({
          id: resolved.entity.id,
          title: resolved.artifact.title,
          content: resolved.artifact.content,
          workspaceRoot: root,
        });
        remapHostedPageTab(resolved.artifact.title, resolved.entity.id);
      },
    });
  }
}

function remapHostedPageTab(title: string, pageId: string): void {
  const canvas = useCanvasStore.getState();
  for (const panel of Object.values(canvas.panels)) {
    for (const tab of panel.tabs) {
      if (tab.type !== 'page' || tab.entityId === pageId) continue;
      if (tab.label !== title && tab.sourceFileName !== title) continue;
      canvas.updateTabByEntityId(tab.entityId, { entityId: pageId });
    }
  }
}

function remapHostedCanvasTabs(
  registered: readonly { path: string; entityId: string; fileName: string }[]
): void {
  const canvas = useCanvasStore.getState();
  for (const panel of Object.values(canvas.panels)) {
    for (const tab of panel.tabs) {
      if (tab.type !== 'sequence' || tab.sequenceDocument?.kind === 'managed-sequence') continue;
      const matches = registered.filter(
        (file) =>
          hostedSnapshotFileMatchesHint(file, tab.sourceFileName) ||
          hostedSnapshotFileMatchesHint(file, tab.label)
      );
      if (matches.length !== 1) continue;
      const match = matches[0];
      const sequenceDocument = catalogSequenceDocumentRef(match.entityId);
      const documentId = sequenceDocumentKey(sequenceDocument);
      if (
        tab.entityId === documentId &&
        tab.sequenceDocument &&
        sequenceDocumentKey(tab.sequenceDocument) === documentId &&
        tab.sourceFileName === match.fileName &&
        tab.loadStatus === 'loaded'
      ) {
        continue;
      }
      canvas.updateTabByEntityId(tab.entityId, {
        entityId: documentId,
        sequenceDocument,
        sourceFileName: match.fileName,
        loadStatus: 'loaded',
      });
    }
  }
}

export function subscribeHostedRevision(listener: (revisionId: string) => void): () => void {
  const emit = () => {
    const { principal, snapshot } = hostedWorkspaceSessionController.getState();
    listener(
      JSON.stringify([
        principal?.id,
        snapshot?.workspaceId,
        snapshot?.revisionId,
        snapshot?.localRevisionId,
      ])
    );
  };
  emit();
  return hostedWorkspaceSessionController.subscribe(emit);
}

export async function resolveHostedTabDocument(
  sourceHint: string | undefined
): Promise<ResolvedSequenceDocument | null> {
  if (!sourceHint) return null;
  const snapshot = hostedWorkspaceSessionController.getState().snapshot;
  if (!snapshot) return null;
  const matches = snapshot.files.filter(
    (candidate) =>
      SEQUENCE_FILE_KINDS.has(inferCatalogFileKind(candidate.path)) &&
      hostedSnapshotFileMatchesHint(candidate, sourceHint)
  );
  if (matches.length !== 1) return null;
  const file = matches[0];
  const path = hostedAbsolutePath(snapshot.workspaceId, file.path);
  const managed = await managedSequenceRepository.findByMemberPath(path);
  if (managed) return resolveSequenceDocument(managed.ref);
  const entity = await registerWorkspaceFile({
    path,
    name: hostedFileNameParts(file.path).base,
    entityType: 'sequence',
    fileKind: inferCatalogFileKind(file.path),
    workspaceRoot: hostedWorkspaceRoot(snapshot.workspaceId),
    sizeBytes: file.sizeBytes,
    contentHash: file.contentSha256 ? `sha256:${file.contentSha256}` : null,
  });
  return resolveSequenceDocument(catalogSequenceDocumentRef(entity.id));
}
