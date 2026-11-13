import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { primerServices } from '../../primers/public/primer-services';
import { reconcileWorkspaceAfterFilesChanged } from '../../../services/workspace-operations';
import { workspaceRootForPrimer } from './primer-lifecycle';
import { PrimerArtifactRevisionError } from '../../primers/public/primer-artifact-service';

const primerRemovalShape = {
  primerId: z.string().min(1),
  workspace: z.string().min(1).optional(),
  expectedArtifactRevision: z.number().int().positive(),
};
export const removePrimerBindingSchema = z.object({ ...primerRemovalShape, bindingId: z.string().min(1) }).strict();
export const deletePrimerSchema = z.object(primerRemovalShape).strict();

function failed(error: unknown, attempted: boolean) {
  const stale = error instanceof PrimerArtifactRevisionError;
  return toolFailure({ code: stale ? error.code : 'PRIMER_REMOVAL_FAILED', error: error instanceof Error ? error.message : String(error),
    retriable: stale, stateChanged: stale ? false : attempted ? 'unknown' : false, partialEffects: [] });
}

export function createRemovePrimerBindingTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: 'Detach an exact primer binding without deleting the primer or its other attachments. Requires the current artifact revision returned by get_primer.',
    inputSchema: removePrimerBindingSchema,
    execute: async (input) => {
      let attempted = false;
      try {
        const primer = await primerServices.persistence.getPrimer(input.primerId);
        if (!primer) throw new Error('The primer is unavailable.');
        const workspaceRoot = workspaceRootForPrimer(folders, primer, input.workspace);
        const read = await primerServices.persistence.readArtifact(primer, workspaceRoot);
        const existed = read.artifact.bindings.some((binding) => binding.id === input.bindingId);
        attempted = true;
        const saved = await primerServices.persistence.detachBinding({ primer, workspaceRoot, bindingId: input.bindingId,
          expectedArtifactRevision: input.expectedArtifactRevision });
        for (const binding of read.resolvedBindings) primerServices.persistence.notifyBindingsChanged(binding.sequenceId);
        return toolSuccess({ changed: existed, primerId: input.primerId, artifactRevision: saved.artifact.artifactRevision,
          bindingCount: saved.artifact.bindings.length, gitCommitted: saved.gitCommitted });
      } catch (error) { return failed(error, attempted); }
    },
  });
}

export function createDeletePrimerTool(folders: WorkspaceFolder[], actionId: string) {
  return resultTool({
    description: 'Remove an exact saved primer and all its bindings. Moves its authoritative artifact to Trash, archives its registry record and commits project history. Requires the revision last returned by get_primer; never deletes a target sequence.',
    inputSchema: deletePrimerSchema,
    execute: async (input) => {
      let attempted = false;
      try {
        const primer = await primerServices.persistence.getPrimer(input.primerId);
        if (!primer) return toolSuccess({ deleted: false, reason: 'not_found' });
        const workspaceRoot = workspaceRootForPrimer(folders, primer, input.workspace);
        attempted = true;
        const deleted = await primerServices.persistence.deleteArtifact({ primer, workspaceRoot,
          expectedArtifactRevision: input.expectedArtifactRevision, operationId: actionId });
        await reconcileWorkspaceAfterFilesChanged({ workspaceRoot, strict: true, notifyGitStatus: true });
        return toolSuccess({ ...deleted, primerId: input.primerId });
      } catch (error) { return failed(error, attempted); }
    },
  });
}
