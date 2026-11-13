import { referenceNavigationLinks } from '../../services/entity-navigation';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../shared/project-root-selection';
import {
  getCatalogEntityForWorkspaceRoot,
  getCurrentCatalogFileForEntity,
  resolveWorkspaceScope,
} from '../../db/workspace-catalog';
import { createEntityReference } from '../../db/entity-references';
import { resolveCanonicalPrimerReference } from '../primers/public/primer-references';
import { createCreateReferenceTool } from '../ai/public/tools/create-reference';
import { encodeInlineReferenceDeclaration } from '../ai/public/inline-reference-codec';

export const notebookReferenceSchema = z
  .object({
    entityType: z.enum(['sequence', 'sequence_region', 'primer', 'assembly', 'notebook']),
    entityId: z.string().min(1),
    workspace: z.string().min(1).optional(),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
    wraps: z.boolean().optional(),
    bindingId: z.string().min(1).optional(),
  })
  .strict();

export async function createNotebookAuthoringReference(
  input: z.infer<typeof notebookReferenceSchema>,
  folders: WorkspaceFolder[],
  options: { toolCallId: string; messages: [] }
) {
  if (input.entityType === 'primer') {
    const primer = await resolveCanonicalPrimerReference(
      { id: input.entityId, workspace: input.workspace, bindingId: input.bindingId },
      folders
    );
    const ref = await createEntityReference({
      entityType: 'primer',
      displayLabel: primer.displayLabel,
      locator: primer.locator,
      deepLinkParams: primer.deepLinkParams,
      data: primer.data,
      source: 'ai',
      workspaceScope: primer.workspaceRoot
        ? await resolveWorkspaceScope(primer.workspaceRoot)
        : null,
      workspaceRootPath: primer.workspaceRoot,
    });
    return {
      referenceId: ref.id,
      ...(await referenceNavigationLinks(ref)),
      inlineLink: encodeInlineReferenceDeclaration({
        kind: 'existing-reference',
        referenceId: ref.id,
      }),
      entityId: primer.registryEntityId,
      registryEntityId: primer.registryEntityId,
      primerId: primer.primerId,
      entityType: input.entityType,
      workspaceRoot: primer.workspaceRoot,
      localOnly: primer.localOnly,
    };
  }
  const selected = input.workspace ? resolveExplicitProjectRoot(folders, input.workspace) : null;
  if (input.workspace && !selected) throw new Error('Choose an exact mounted source project.');
  const roots = selected ? [selected] : folders;
  const matches = (
    await Promise.all(
      roots.map(async (root) => ({
        root,
        entity: await getCatalogEntityForWorkspaceRoot(input.entityId, root.path),
      }))
    )
  ).filter((candidate) => candidate.entity?.status === 'active');
  if (matches.length !== 1)
    throw new Error(
      matches.length > 1
        ? 'This identity exists in multiple projects. Specify its source project.'
        : 'The exact entity is unavailable in the mounted projects.'
    );
  const { root, entity } = matches[0];
  if (input.entityType === 'sequence' || input.entityType === 'sequence_region') {
    if (input.entityType === 'sequence_region' && (!input.start || !input.end))
      throw new Error(
        'A source region requires exact 1-based inclusive start and end coordinates.'
      );
    const result = await createCreateReferenceTool([root]).execute?.(
      {
        entityType: input.entityType,
        displayLabel: entity!.name,
        documentId: input.entityId,
        deepLinkParams:
          input.entityType === 'sequence_region'
            ? {
                start: input.start,
                end: input.end,
                ...(input.wraps !== undefined ? { wraps: input.wraps } : {}),
              }
            : {},
      },
      options
    );
    if (!result || !('referenceId' in result))
      throw new Error('The source reference could not be created.');
    if (!result.ok) throw new Error(result.error);
    if (!result.referenceId) throw new Error('The source reference could not be created.');
    return {
      ...result,
      entityId: input.entityId,
      entityType: input.entityType,
      workspaceRoot: root.path,
    };
  }
  const data = null;
  const deepLinkParams = null;
  const file = await getCurrentCatalogFileForEntity(input.entityId);
  if (
    !file ||
    file.file_kind !== (input.entityType === 'assembly' ? 'waypoint-design' : 'waypoint-notebook')
  )
    throw new Error('The entity is not the requested native document type.');
  const ref = await createEntityReference({
    entityType: input.entityType,
    displayLabel: entity!.name,
    locator: `entity://${input.entityType === 'notebook' ? 'page' : input.entityType}/${input.entityId}`,
    deepLinkParams,
    data,
    source: 'ai',
    workspaceScope: await resolveWorkspaceScope(root.path),
    workspaceRootPath: root.path,
  });
  return {
    referenceId: ref.id,
    ...(await referenceNavigationLinks(ref)),
    inlineLink: encodeInlineReferenceDeclaration({
      kind: 'existing-reference',
      referenceId: ref.id,
    }),
    entityId: input.entityId,
    entityType: input.entityType,
    workspaceRoot: root.path,
  };
}
