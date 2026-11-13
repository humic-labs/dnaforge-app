import { withUserMessage } from '@waypoint/user-messages';
import { getWorkspaceRootById } from '../../../db/workspace-catalog';
import { useState, useCallback, useEffect } from 'react';
import { primerArtifactRelativePath } from '../primer-artifact-service';
import { createFileAuthoritativePrimer } from '../create-file-authoritative-primer';
import type { CreatePrimerInput, UpdatePrimerInput, BoundPrimer, Primer } from '../types';
import { runWorkflowAction } from '../../../lib/workflow-telemetry';
import { subscribePrimerBindingsChanged } from '../primer-binding-events';
import { primerServices } from '../primer-services';

export function usePrimers(sequenceId: number | null, workspaceRoot?: string) {
  const [primers, setPrimers] = useState<BoundPrimer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadPrimers = useCallback(async () => {
    if (sequenceId == null) {
      setPrimers([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await primerServices.persistence.listLegacyBoundPrimers(sequenceId);
      setPrimers(result);
    } catch (err) {
      console.error('Failed to load primers:', err instanceof Error ? err.message : err);
      setError(
        err instanceof Error
          ? err
          : withUserMessage(new Error('Failed to load primers'), 'failure.failed-to-load-primers')
      );
    } finally {
      setIsLoading(false);
    }
  }, [sequenceId]);

  useEffect(() => {
    loadPrimers();
  }, [loadPrimers]);

  useEffect(() => {
    if (sequenceId == null) return undefined;
    return subscribePrimerBindingsChanged((changedSequenceId) => {
      if (changedSequenceId === sequenceId) void loadPrimers();
    });
  }, [sequenceId, loadPrimers]);

  const handleCreate = useCallback(
    async (input: CreatePrimerInput) => {
      await createFileAuthoritativePrimer(input);
      await loadPrimers();
    },
    [loadPrimers]
  );

  const canonicalOwner = useCallback(async (primer: Primer) => {
    const file = await primerServices.persistence.getCatalogFile(primer.id);
    const owner = await getWorkspaceRootById(file?.workspace_id ?? null);
    if (!file || !owner) throw new Error('The canonical primer has no current owning project.');
    const loaded = await primerServices.persistence.readArtifact(primer, owner);
    return { owner, loaded };
  }, []);

  const handleUpdate = useCallback(
    async (input: UpdatePrimerInput) => {
      const updated = await runWorkflowAction(
        { workflow: 'primer', action: 'update' },
        async () => {
          const primer = await primerServices.persistence.getPrimer(input.id);
          if (!primer || !primerArtifactRelativePath(primer))
            return primerServices.persistence.updateLegacyPrimer(input);
          const unsupported = Object.entries(input).filter(
            ([key, value]) =>
              value !== undefined && !['id', 'name', 'sequence', 'notes'].includes(key)
          );
          if (unsupported.length)
            throw new Error(
              `The canonical primer editor does not support these fields: ${unsupported.map(([key]) => key).join(', ')}.`
            );
          const { owner, loaded } = await canonicalOwner(primer);
          return (
            await primerServices.persistence.updateArtifactContent({
              artifactPath: loaded.path,
              workspaceRoot: owner,
              expectedArtifactRevision: loaded.artifact.artifactRevision,
              name: input.name ?? loaded.artifact.name,
              sequence: input.sequence ?? loaded.artifact.sequence.bases,
              ...(input.notes === undefined ? {} : { notes: input.notes }),
              actor: 'local-user',
            })
          ).primer;
        },
        (result) => ({
          status: result ? 'updated' : 'no_match',
          affectedCount: result ? 1 : 0,
        })
      );
      if (updated) {
        await loadPrimers();
      }
      return updated;
    },
    [loadPrimers, canonicalOwner]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await runWorkflowAction(
        { workflow: 'primer', action: 'delete' },
        async () => {
          const primer = await primerServices.persistence.getPrimer(id);
          if (!primer || !primerArtifactRelativePath(primer))
            return primerServices.persistence.deleteLegacyPrimer(id);
          const { owner, loaded } = await canonicalOwner(primer);
          return primerServices.persistence.deleteArtifact({
            primer,
            workspaceRoot: owner,
            expectedArtifactRevision: loaded.artifact.artifactRevision,
            operationId: crypto.randomUUID(),
          });
        },
        (deleted) => ({
          status: deleted.deleted ? 'deleted' : 'no_match',
          affectedCount: deleted.deleted ? 1 : 0,
        })
      );
      if (result.deleted) {
        setPrimers((prev) => prev.filter((p) => p.id !== id));
      }
      return result;
    },
    [canonicalOwner]
  );

  const handleDetach = useCallback(
    async (bindingId: string) => {
      const primer = primers.find((candidate) => candidate.binding.id === bindingId);
      await runWorkflowAction(
        { workflow: 'primer', action: 'detach' },
        async () => {
          if (primer && primerArtifactRelativePath(primer)) {
            if (!workspaceRoot) {
              throw new Error('Cannot detach a file-backed primer without its owning project.');
            }
            await primerServices.persistence.detachBinding({ primer, workspaceRoot, bindingId });
          } else {
            await primerServices.persistence.deleteLegacyBinding(bindingId);
          }
        },
        () => ({ status: 'detached', affectedCount: 1 })
      );
      setPrimers((prev) => prev.filter((p) => p.binding.id !== bindingId));
    },
    [primers, workspaceRoot]
  );

  return {
    primers,
    isLoading,
    error,
    reload: loadPrimers,
    create: handleCreate,
    update: handleUpdate,
    delete: handleDelete,
    detach: handleDetach,
  };
}
