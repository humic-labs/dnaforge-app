import type { DBEntityReference } from '../db/entity-references';
import { getEntityReference, prepareEntityReferenceRow } from '../db/entity-references';
import { getCatalogEntityForWorkspaceRoot } from '../db/workspace-catalog';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { platform } from '../platform';
import {
  entityNavigationLink,
  entityNavigationTargetSchema,
  type EntityNavigationTarget,
} from '../shared/entity-navigation';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { openWorkspaceFromSource } from '../features/workspace-loader/open-workspace-from-source';
import {
  getCanonicalOligoEntity,
  resolveCanonicalPrimerReference,
} from '../features/primers/public/primer-references';
import { resolveExactNativeCatalogDestination } from './native-catalog-destination';
import { parseLimsSchemaFields } from '../shared/lims';

export function referenceEntityIdentity(reference: DBEntityReference): string {
  const data = reference.data ? JSON.parse(reference.data) : null;
  if (reference.entity_type === 'primer' && typeof data?.registryEntityId === 'string')
    return data.registryEntityId;
  if (typeof data?.documentId === 'string') return data.documentId;
  const entityId = /^entity:\/\/[^/]+\/(.+)$/.exec(reference.locator)?.[1];
  return entityId ?? reference.id;
}

export async function referenceNavigationLinks(reference: DBEntityReference) {
  if (reference.entity_type === 'primer' && !reference.workspace_root_path) {
    const data = reference.data ? JSON.parse(reference.data) : null;
    if (data?.localOnly !== true) return { externalUrl: null, shellCommand: null };
  }
  const projectId = reference.workspace_root_path
    ? await activeEntityProjectScope(reference.workspace_root_path)
    : null;
  if (reference.workspace_root_path && !projectId) return { externalUrl: null, shellCommand: null };
  return entityNavigationLink(
    {
      entityId: referenceEntityIdentity(reference),
      ...(projectId ? { projectId } : {}),
      referenceId: reference.id,
    },
    await platform().entityNavigation.getScheme()
  );
}

interface EntityProjectOwner {
  id: number;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
}

function activeProjectOwner(owner: EntityProjectOwner): boolean {
  return owner.archived_at === null && owner.trashed_at === null;
}

async function activeEntityProjectScope(root: string): Promise<string | null> {
  const owners = await platform().db.select<EntityProjectOwner[]>(
    'SELECT id,path,repo_uuid,archived_at,trashed_at FROM workspaces WHERE path = ?',
    [root]
  );
  if (owners.length !== 1 || !activeProjectOwner(owners[0])) return null;
  return workspaceScopeKey(owners[0].repo_uuid, owners[0].id);
}

export async function resolveEntityProjectRoot(projectId: string): Promise<string> {
  const owners = await platform().db.select<EntityProjectOwner[]>(
    'SELECT id,path,repo_uuid,archived_at,trashed_at FROM workspaces'
  );
  const matching = owners.filter(
    (owner) =>
      activeProjectOwner(owner) && workspaceScopeKey(owner.repo_uuid, owner.id) === projectId
  );
  if (matching.length !== 1)
    throw new Error('The owning project is unavailable on this installation.');
  return matching[0].path;
}

export async function mountOwner(root: string): Promise<void> {
  if (!(await activeEntityProjectScope(root)))
    throw new Error('The owning project is unavailable on this installation.');
  if (useWorkspaceStore.getState().folders.some((folder) => folder.path === root)) return;
  const opened = await openWorkspaceFromSource(
    { kind: 'local-folder', path: root },
    { inPlace: true, makeCurrent: true }
  );
  if (
    opened.superseded ||
    !useWorkspaceStore.getState().folders.some((folder) => folder.path === root)
  )
    throw new Error('The owning project could not be opened.');
}

export async function resolveEntityNavigationTarget(
  input: EntityNavigationTarget,
  referenceHint?: DBEntityReference
) {
  const target = entityNavigationTargetSchema.parse(input);
  if (target.referenceId) {
    let reference = referenceHint ?? (await getEntityReference(target.referenceId));
    if (!reference || reference.id !== target.referenceId || reference.status !== 'created')
      throw new Error('The saved entity selection is unavailable.');
    const root = reference.workspace_root_path;
    const projectId = root ? await activeEntityProjectScope(root) : null;
    if (root && !projectId)
      throw new Error('The owning project is unavailable on this installation.');
    const originalIdentity = referenceEntityIdentity(reference);
    if (reference.entity_type === 'primer') {
      const data = reference.data ? JSON.parse(reference.data) : null;
      if (data?.localOnly === true && !reference.workspace_root_path) {
        const entity = await getCanonicalOligoEntity(data.registryEntityId);
        if (
          target.entityId !== entity.id ||
          data.bindingId ||
          data.targetDocumentId ||
          reference.deep_link_params
        )
          throw new Error(
            'The standalone Registry reference does not match its canonical identity or selection.'
          );
      } else if (!referenceHint || typeof data?.registryEntityId === 'string') {
        const params = reference.deep_link_params ? JSON.parse(reference.deep_link_params) : null;
        const root = reference.workspace_root_path;
        const primer = await resolveCanonicalPrimerReference(
          {
            id: originalIdentity,
            ...(root ? { workspace: root } : {}),
            bindingId: typeof data?.bindingId === 'string' ? data.bindingId : undefined,
            documentId:
              typeof data?.targetDocumentId === 'string'
                ? data.targetDocumentId
                : typeof data?.documentId === 'string'
                  ? data.documentId
                  : undefined,
            bindingStart: params?.bindingStart,
            bindingEnd: params?.bindingEnd,
          },
          root ? [{ path: root, name: root, addedAt: 0 }] : useWorkspaceStore.getState().folders
        );
        if (![originalIdentity, primer.registryEntityId, primer.primerId].includes(target.entityId))
          throw new Error('The saved selection belongs to a different entity.');
        if (primer.workspaceRoot !== reference.workspace_root_path)
          throw new Error('Recreate this legacy reference with its exact owning project.');
        reference = {
          ...reference,
          locator: primer.locator,
          data: JSON.stringify(primer.data),
          deep_link_params: primer.deepLinkParams ? JSON.stringify(primer.deepLinkParams) : null,
        };
      } else if (originalIdentity !== target.entityId)
        throw new Error('The saved selection belongs to a different entity.');
    } else if (originalIdentity !== target.entityId)
      throw new Error('The saved selection belongs to a different entity.');
    if ((target.projectId ?? null) !== projectId && !referenceHint)
      throw new Error('The entity link does not match its owning project.');
    if (target.projectId && projectId && target.projectId !== projectId)
      throw new Error('The entity link does not match its owning project.');
    if (
      reference.entity_type === 'protein' &&
      reference.locator.startsWith('git://') &&
      typeof (reference.data ? JSON.parse(reference.data) : null)?.documentId === 'string'
    ) {
      if (!root) throw new Error('The canonical file reference has no owning project.');
      const destination = await resolveExactNativeCatalogDestination({
        entityId: originalIdentity,
        workspaceRoot: root,
      });
      const registry =
        destination?.entityType === 'record'
          ? (
              await platform().db.select<Array<{ kind: string; schema_fields: string | null }>>(
                'SELECT l.kind,r.fields AS schema_fields FROM lims_entity l LEFT JOIN lims_schema_revision r ON r.id=l.schema_revision_id WHERE l.id=? AND l.tombstone=0 AND l.archived_at IS NULL',
                [originalIdentity]
              )
            )[0]
          : null;
      if (
        !destination ||
        !(
          destination.locator.kind === 'workspace_path' ||
          (destination.locator.kind === 'lims_entity' &&
            destination.locator.entityId === originalIdentity)
        ) ||
        (destination.entityType !== 'protein' &&
          !(
            registry &&
            (registry.kind === 'protein' ||
              (registry.schema_fields &&
                parseLimsSchemaFields(registry.schema_fields).baseKind === 'protein'))
          ))
      )
        throw new Error(
          'The canonical file reference target is unavailable or its kind has changed.'
        );
    }
    return { kind: 'reference' as const, reference };
  }
  const root = target.projectId ? await resolveEntityProjectRoot(target.projectId) : null;
  if (root) {
    const entity = await getCatalogEntityForWorkspaceRoot(target.entityId, root);
    if (entity?.type === 'primer' || !entity) {
      const primer = await resolveCanonicalPrimerReference(
        { id: target.entityId, workspace: root },
        [
          ...useWorkspaceStore.getState().folders.filter((folder) => folder.path !== root),
          { path: root, name: root, addedAt: 0 },
        ]
      );
      return {
        kind: 'reference' as const,
        reference: prepareEntityReferenceRow({
          entityType: 'primer',
          displayLabel: primer.displayLabel,
          locator: primer.locator,
          data: primer.data,
          deepLinkParams: null,
          source: 'navigation',
          workspaceScope: target.projectId ?? null,
          workspaceRootPath: root,
        }),
      };
    }
    const destination = await resolveExactNativeCatalogDestination({
      entityId: target.entityId,
      workspaceRoot: root,
    });
    if (!destination) throw new Error('The entity is unavailable in its owning project.');
    return { kind: 'catalog' as const, entityId: destination.entityId, root };
  }
  const entity = (
    await platform().lims.queryEntities({ id: target.entityId, includeArchived: true, limit: 1 })
  )[0];
  if (!entity || entity.tombstone || entity.archivedAt !== null)
    throw new Error(
      'The canonical entity is unavailable. Include the owning project for project artifacts.'
    );
  return { kind: 'registry' as const, entityId: entity.id };
}

export async function mountReferenceOwners(reference: DBEntityReference) {
  if (reference.workspace_root_path) await mountOwner(reference.workspace_root_path);
  if (reference.entity_type !== 'primer' || !reference.data) return;
  const data = JSON.parse(reference.data) as Record<string, unknown>;
  if (
    typeof data.registryEntityId === 'string' &&
    typeof data.bindingId === 'string' &&
    typeof data.targetProjectId === 'string'
  )
    await mountOwner(await resolveEntityProjectRoot(data.targetProjectId));
}

export async function resolveReferenceNavigation(reference: DBEntityReference) {
  const links = await referenceNavigationLinks(reference);
  const resolved = await resolveEntityNavigationTarget(
    'target' in links
      ? links.target
      : { entityId: referenceEntityIdentity(reference), referenceId: reference.id },
    reference
  );
  if (resolved.kind !== 'reference') throw new Error('The saved reference could not be resolved.');
  await mountReferenceOwners(resolved.reference);
  return resolved.reference;
}
