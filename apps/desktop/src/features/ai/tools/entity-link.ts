import { z } from 'zod';
import { getEntityReference } from '../../../db/entity-references';
import {
  getCatalogEntityForWorkspaceRoot,
  resolveWorkspaceScope,
} from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import {
  entityNavigationLink,
  entityNavigationTargetSchema,
} from '../../../shared/entity-navigation';
import {
  referenceEntityIdentity,
  referenceNavigationLinks,
  resolveEntityNavigationTarget,
} from '../../../services/entity-navigation';
import { resolveCanonicalPrimerReference } from '../../primers/public/primer-references';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';

export const GET_ENTITY_LINK_DESCRIPTION =
  'Return a working external DNAForge hyperlink and foreground shell-open command for a stable entityId. DNAForge determines the entity type and view; callers use the same contract for sequences, primers, assembly drafts, notebooks and other entities. Specify workspace or projectId when ownership is ambiguous. Optional referenceId preserves an exact saved interval, primer attachment or molecular selection. Does not open or activate the app.';

export const getEntityLinkSchema = entityNavigationTargetSchema.extend({
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Exact mounted owning project name or root; the app resolves its stable project identity.'
    ),
});

export function createGetEntityLinkTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: GET_ENTITY_LINK_DESCRIPTION,
    inputSchema: getEntityLinkSchema,
    execute: async (input) => {
      try {
        let projectId = input.projectId;
        if (input.workspace) {
          const root = resolveExplicitProjectRoot(folders, input.workspace);
          if (!root) throw new Error('Choose the exact mounted owning project.');
          const id = await resolveWorkspaceScope(root.path);
          if (!id || (projectId && projectId !== id))
            throw new Error('The supplied project identities disagree.');
          projectId = id;
        }
        if (input.referenceId && !projectId) {
          const reference = await getEntityReference(input.referenceId);
          if (!reference) throw new Error('The saved selection is unavailable.');
          const links = await referenceNavigationLinks(reference);
          if ('target' in links) projectId = links.target.projectId;
          else throw new Error('The owning project has no stable identity.');
        }
        if (!projectId && !input.referenceId) {
          const matches = (
            await Promise.all(
              folders
                .filter((folder) => !folder.pinned)
                .map(async (folder) => ({
                  folder,
                  entity: await getCatalogEntityForWorkspaceRoot(input.entityId, folder.path),
                }))
            )
          ).filter((match) => match.entity?.status === 'active');
          if (matches.length > 1)
            throw new Error(
              'This identity is present in multiple projects. Specify its owning workspace.'
            );
          let root: string | undefined = matches[0]?.folder.path;
          if (!root) {
            const entity = (
              await platform().lims.queryEntities({
                id: input.entityId,
                includeArchived: true,
                limit: 1,
              })
            )[0];
            if (entity && ['oligo', 'rna_oligo'].includes(entity.kind))
              root =
                (await resolveCanonicalPrimerReference({ id: input.entityId }, folders))
                  .workspaceRoot ?? undefined;
          }
          if (root) projectId = (await resolveWorkspaceScope(root)) ?? undefined;
        }
        const target = {
          entityId: input.entityId,
          ...(projectId ? { projectId } : {}),
          ...(input.referenceId ? { referenceId: input.referenceId } : {}),
        };
        const resolved = await resolveEntityNavigationTarget(target);
        if (resolved.kind === 'reference')
          target.entityId = referenceEntityIdentity(resolved.reference);
        return toolSuccess(
          entityNavigationLink(target, await platform().entityNavigation.getScheme())
        );
      } catch (error) {
        return toolFailure({
          code: 'ENTITY_NAVIGATION_UNAVAILABLE',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}
