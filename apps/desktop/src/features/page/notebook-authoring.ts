import { referenceNavigationLinks } from '../../services/entity-navigation';
import type { JSONContent } from '@tiptap/core';
import type { z } from 'zod';
import { platform } from '../../platform';
import { getCanonicalOligoEntity } from '../primers/public/primer-references';
import { createEntityReference, getEntityReferencesByIds } from '../../db/entity-references';
import {
  getCatalogEntityForWorkspaceRoot,
  getCurrentCatalogFileForEntity,
  resolveWorkspaceScope,
} from '../../db/workspace-catalog';
import { createNotebookArtifactFile } from '../../db/workspace-artifacts';
import { notebookPackagePaths } from '../../db/notebook-package';
import { canonicalNotebookJson } from '../../db/notebook-markdown-codec';
import { readNotebookSourceSnapshot } from '../../db/entity-substrate/notebook-source-snapshot';
import { contentFingerprint } from '../../shared/content-fingerprint';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';
import { normalizeNotebookReferences } from '../../shared/notebook-reference-normalization';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { usePageStore } from './store';
import {
  compileNotebookBlocks,
  notebookBlockReferenceIds,
  type notebookBlocksSchema,
} from './notebook-authoring-content';
import { encodeInlineReferenceDeclaration } from '../ai/public/inline-reference-codec';

type Blocks = z.infer<typeof notebookBlocksSchema>;

async function validateReferences(blocks: Blocks, mountedRoots: readonly string[]) {
  const ids = notebookBlockReferenceIds(blocks);
  const references = await getEntityReferencesByIds(ids);
  for (const id of ids) {
    const reference = references.find((item) => item.id === id && item.status === 'created');
    if (!reference) throw new Error(`Notebook reference is unavailable: ${id}`);
    if (!reference.workspace_root_path) {
      const data = reference.data ? JSON.parse(reference.data) : null;
      if (
        reference.entity_type !== 'primer' ||
        data?.localOnly !== true ||
        typeof data.registryEntityId !== 'string'
      )
        throw new Error(`The project owning reference ${id} must be mounted.`);
      await getCanonicalOligoEntity(data.registryEntityId);
    } else if (!mountedRoots.includes(reference.workspace_root_path)) {
      throw new Error(`The project owning reference ${id} must be mounted.`);
    }
  }
}

export async function readAuthoredNotebook(workspaceRoot: string, notebookId: string) {
  const entity = await getCatalogEntityForWorkspaceRoot(notebookId, workspaceRoot);
  if (!entity || entity.type !== 'notebook' || entity.status !== 'active')
    throw new Error('The notebook does not belong to the selected project.');
  const file = await getCurrentCatalogFileForEntity(notebookId);
  if (!file || file.workspace_id !== entity.workspace_id || file.file_kind !== 'waypoint-notebook')
    throw new Error('The notebook has no current native package.');
  const paths = notebookPackagePaths(file.path);
  const snapshot = await readNotebookSourceSnapshot(
    paths.metaPath,
    await platform().fs.readTextFile(paths.metaPath)
  );
  return {
    notebookId,
    workspaceRoot,
    title: snapshot.parsed.title,
    revision: contentFingerprint(snapshot.markdown),
    content: snapshot.parsed.content,
    packagePath: file.path,
    provenance: snapshot.metadata.provenance ?? [],
  };
}

async function withNotebookReference(snapshot: Awaited<ReturnType<typeof readAuthoredNotebook>>) {
  const reference = await createEntityReference({
    entityType: 'notebook',
    displayLabel: snapshot.title,
    locator: `entity://page/${snapshot.notebookId}`,
    deepLinkParams: null,
    data: null,
    source: 'ai',
    workspaceScope: await resolveWorkspaceScope(snapshot.workspaceRoot),
    workspaceRootPath: snapshot.workspaceRoot,
  });
  return {
    ...snapshot,
    referenceId: reference.id,
    ...(await referenceNavigationLinks(reference)),
    inlineLink: encodeInlineReferenceDeclaration({
      kind: 'existing-reference',
      referenceId: reference.id,
    }),
  };
}

export async function createAuthoredNotebook(input: {
  workspaceRoot: string;
  mountedRoots: readonly string[];
  title: string;
  intentId: string;
  blocks: Blocks;
  operationId: string;
}) {
  await validateReferences(input.blocks, input.mountedRoots);
  const content = compileNotebookBlocks(input.blocks);
  const scope = await resolveWorkspaceScope(input.workspaceRoot);
  if (!scope) throw new Error('The selected project has no stable identity.');
  const intentDigest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.intentId))
  );
  const rawId = `agent-notebook-${Array.from(intentDigest, (byte) =>
    byte.toString(16).padStart(2, '0')
  )
    .join('')
    .slice(0, 32)}`;
  const notebookId = scopedProjectionId(scope, rawId);
  const snapshot = await withRendererWorkspaceMutation(
    input.workspaceRoot,
    async (mutationToken) => {
      const existing = await getCatalogEntityForWorkspaceRoot(notebookId, input.workspaceRoot);
      if (existing) {
        const current = await readAuthoredNotebook(input.workspaceRoot, notebookId);
        if (
          current.title !== input.title ||
          canonicalNotebookJson(current.content) !==
            canonicalNotebookJson(normalizeNotebookReferences(content))
        )
          throw new Error(
            'This notebook intent already created different content. Use update_notebook with its current revision.'
          );
        return current;
      }
      const artifact = await createNotebookArtifactFile({
        entityId: notebookId,
        pageId: notebookId,
        title: input.title,
        content,
        workspaceRoot: input.workspaceRoot,
        mutationToken,
        agentProvenance: { actor: 'agent', operationId: input.operationId },
      });
      if (!artifact)
        throw new Error('The notebook could not be published to the selected project.');
      const saved = await readAuthoredNotebook(input.workspaceRoot, notebookId);
      const accepted = await usePageStore.getState().upsertPageFromArtifact({
        id: notebookId,
        title: input.title,
        content,
        workspaceRoot: input.workspaceRoot,
        authorityFingerprint: saved.revision,
        mutationToken,
      });
      if (!accepted)
        throw new Error('The notebook file was saved but its open editor could not be updated.');
      return saved;
    }
  );
  useWorkspaceStore.getState().bumpFileTreeRefresh();
  return withNotebookReference(snapshot);
}

export async function updateAuthoredNotebook(input: {
  workspaceRoot: string;
  mountedRoots: readonly string[];
  notebookId: string;
  expectedRevision: string;
  mode: 'append' | 'replace';
  blocks: Blocks;
  operationId: string;
}) {
  await validateReferences(input.blocks, input.mountedRoots);
  const current = await readAuthoredNotebook(input.workspaceRoot, input.notebookId);
  if (current.revision !== input.expectedRevision)
    throw new Error('The notebook revision changed. Read it again before updating.');
  if (usePageStore.getState().dirtyIds.has(input.notebookId))
    throw new Error('The notebook has unsaved editor changes. Save them before agent editing.');
  const next = compileNotebookBlocks(input.blocks);
  const content: JSONContent =
    input.mode === 'append'
      ? { type: 'doc', content: [...(current.content.content ?? []), ...(next.content ?? [])] }
      : next;
  await usePageStore.getState().fetchPage(input.notebookId);
  const revision = await usePageStore.getState().savePage(input.notebookId, content, {
    expectedCanonicalFingerprint: input.expectedRevision,
    agentProvenance: { actor: 'agent', operationId: input.operationId },
  });
  if (!revision) throw new Error('The notebook update did not produce a saved revision.');
  return withNotebookReference(await readAuthoredNotebook(input.workspaceRoot, input.notebookId));
}
