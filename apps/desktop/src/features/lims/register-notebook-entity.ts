import { platform } from '../../platform';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';

const NOTEBOOK_META_SUFFIX = '/.forge/notebook.json';

export function notebookPackageRootFromAdapterPath(path: string): string {
  return path.endsWith(NOTEBOOK_META_SUFFIX) ? path.slice(0, -NOTEBOOK_META_SUFFIX.length) : path;
}

export async function ensureNotebookRegisteredInLims(input: {
  id: string;
  name: string;
  packagePath: string;
  workspaceId?: number | null;
  mutationToken?: string;
}): Promise<void> {
  if (isDeveloperImportSourcePath(input.packagePath)) return;
  try {
    const lims = platform().lims;
    const existing = await lims.queryEntities({
      id: input.id,
      includeArchived: true,
      limit: 1,
    });
    const entity = existing[0];
    if (entity) {
      if (entity.kind !== 'notebook') {
        throw new Error(`Notebook Registry identity belongs to another kind: ${input.id}`);
      }
      const workspaceId = input.workspaceId === undefined ? entity.workspaceId : input.workspaceId;
      if (
        entity.name === input.name &&
        entity.fields.packagePath === input.packagePath &&
        entity.workspaceId === workspaceId
      ) {
        return;
      }

      await lims.updateEntity(
        {
          id: input.id,
          name: input.name,
          fields: { packagePath: input.packagePath },
          workspaceId,
          actor: 'workspace-reconcile',
          expectedEventSeq: entity.eventSeq ?? undefined,
        },
        input.mutationToken
      );
      return;
    }

    await lims.registerEntity(
      {
        id: input.id,
        kind: 'notebook',
        name: input.name,
        fields: { packagePath: input.packagePath },
        workspaceId: input.workspaceId ?? null,
        registrationStatus: 'registered',
      },
      input.mutationToken
    );
  } catch (error) {
    console.warn('[lims] notebook registration failed', error);
  }
}
