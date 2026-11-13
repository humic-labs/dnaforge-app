import { z } from 'zod';
import { decodeSequenceDocument } from '@waypoint/sequence-utils';
import { defineBlob } from '@waypoint/workspace-revisions';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { searchPrimerMatchesSchema } from '../../../shared/primer-match-report';
import { readScientificText } from '../../scientific-document/public/read-scientific-text';
import { resolveSequenceDocumentById } from '../../sequence/public/sequence-document-repository';
import { primerServices } from '../../primers/public/primer-services';
import { readPrimerArtifactForPrimer } from '../../primers/public/primer-artifact-service';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { getUserFolders, normalizeSequenceDocumentId } from './path-utils';

export { searchPrimerMatchesSchema };


export function projectPrimerMatchPreparation(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Record<string, unknown>;
  if (value.ok !== true || !Array.isArray(value.targets)) return { ok: false, error: value.error };
  return {
    ok: true,
    primerPins: value.primerPins,
    targets: value.targets.map((target: Record<string, unknown>) => {
      const { input: _input, ...pin } = target;
      return pin;
    }),
  };
}


export function createSearchPrimerMatchesTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: 'Prepare saved DNA primer and complete reference snapshots for the service-owned retained search. Searches complete ordered oligos; paired PCR products require separate prediction.',
    inputSchema: searchPrimerMatchesSchema,
    execute: async (input: z.infer<typeof searchPrimerMatchesSchema>, context) => {
      try {
        const roots = getUserFolders(folders);
        const project = input.workspace ? resolveExplicitProjectRoot(roots, input.workspace) : roots.length === 1 ? roots[0] : undefined;
        if (!project) throw new Error('Select one open project, providing workspace when multiple projects are open.');
        const primerIds = [...new Set(input.primerIds)].sort();
        const primers = [];
        const primerPins = [];
        for (const primerId of primerIds) {
          context.abortSignal?.throwIfAborted();
          const primer = await primerServices.persistence.getPrimer(primerId);
          if (!primer) throw new Error(`Saved primer not found: ${primerId}`);
          const loaded = await readPrimerArtifactForPrimer(primer, project.path);
          if (loaded.artifact.oligo?.orderType === 'rna') throw new Error('DNA reference matching does not accept an RNA oligo.');
          const hash = defineBlob(new TextEncoder().encode(loaded.content)).hash.slice('sha256:'.length);
          primers.push({ id: primerId, sequence: loaded.artifact.sequence.bases, revision: loaded.acceptedRevision?.resourceRevisionId ?? `sha256:${hash}` });
          primerPins.push({ primerId, name: loaded.artifact.name, artifactRevision: loaded.artifact.artifactRevision, contentSha256: hash, acceptedRevision: loaded.acceptedRevision });
        }
        const targets = [];
        for (const documentId of [...new Set(input.targetDocumentIds.map(normalizeSequenceDocumentId))]) {
          context.abortSignal?.throwIfAborted();
          const resolved = await resolveSequenceDocumentById(documentId, [project.path]);
          const loaded = await readScientificText(resolved.sourcePath, project.path);
          const target = decodeSequenceDocument(loaded.content).sequence;
          if (!target.sequence.length) throw new Error(`Reference sequence is empty: ${documentId}`);
          const hash = defineBlob(new TextEncoder().encode(loaded.content)).hash.slice('sha256:'.length);
          targets.push({
            documentId, name: resolved.name ?? target.name,
            length: target.sequence.length, circular: target.circular === true,
            contentSha256: hash, acceptedRevision: loaded.acceptedRevision,
            input: {
              targetDocumentId: documentId, referenceSequence: target.sequence,
              circular: target.circular === true, primers,
              maxEditDistance: input.maxEditDistance, maxMismatches: input.maxMismatches,
              minMatchLength: input.minThreePrimeMatchLength, minEffectiveTm: 0,
            },
          });
        }
        return toolSuccess({ primerPins, targets });
      } catch (error) {
        return toolFailure({ code: 'PRIMER_MATCH_INPUT_RESOLUTION_FAILED', error: error instanceof Error ? error.message : String(error), retriable: false, stateChanged: false, partialEffects: [] });
      }
    },
  });
}
