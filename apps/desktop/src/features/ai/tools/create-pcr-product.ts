import { z } from 'zod';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { defineBlob } from '@waypoint/workspace-revisions';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { createPcrProductSchema, predictPcrProducts } from '../../../shared/pcr-product';
import { composeSequenceProduct, type SequenceProductCreation } from '../../../shared/sequence-product';
import { createDnaSequencePackage, normalizeEmptyDnaSequenceName, SequenceCreationPendingError } from '../../sequence/public/create-empty-dna-sequence';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { readAcceptedDnaSources } from './sequence-product-sources';
import { getUserFolders, normalizeSequenceDocumentId, resolveWorkspacePath } from './path-utils';

export { createPcrProductSchema };

export function createCreatePcrProductTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: 'Predict and save an exact planned PCR molecule from accepted saved oligos and a template. Tests inward-facing, nonoverlapping exact 3-prime annealing on both strands, including circular origin crossing. Includes complete ordered oligos and their 5-prime tails. Returns no product or a candidate choice without writing when no unique product is selected. This is sequence prediction, not experimental amplification or a mismatch-tolerant off-target check.',
    inputSchema: createPcrProductSchema,
    execute: async (input: z.infer<typeof createPcrProductSchema>, context) => {
      let mutationStarted = false;
      try {
        const roots = getUserFolders(folders);
        const selected = input.workspace ? resolveExplicitProjectRoot(roots, input.workspace) : roots.length === 1 ? roots[0] : undefined;
        if (!selected) throw new Error('Select one open project, providing workspace when multiple projects are open.');
        const templateId = normalizeSequenceDocumentId(input.templateDocumentId);
        const forwardId = input.forwardPrimerId, reverseId = input.reversePrimerId;
        const { sources, pins, kinds } = await readAcceptedDnaSources(selected.path, [templateId, forwardId, reverseId], context.abortSignal);
        if (kinds.get(templateId) !== 'sequence' || kinds.get(forwardId) !== 'primer' || kinds.get(reverseId) !== 'primer') throw new Error('Choose an accepted DNA template sequence and two accepted DNA primer records.');
        const template = sources.get(templateId)!, forward = sources.get(forwardId)!, reverse = sources.get(reverseId)!;
        const candidates = predictPcrProducts({ templateDocumentId: templateId, template, forwardPrimerId: forwardId, forward: forward.sequence, reversePrimerId: reverseId, reverse: reverse.sequence, forwardAnnealingLength: input.forwardAnnealingLength, reverseAnnealingLength: input.reverseAnnealingLength, maxProductLength: input.maxProductLength });
        const evidence = {
          planned: true, candidateCount: candidates.length,
          matching: { mode: 'exact-3-prime-annealing', nonoverlappingSites: true, maxProductLength: input.maxProductLength, forwardAnnealingLength: input.forwardAnnealingLength ?? forward.length, reverseAnnealingLength: input.reverseAnnealingLength ?? reverse.length },
          inputs: [templateId, forwardId, reverseId].map(documentId => ({ documentId, name: sources.get(documentId)!.name, revision: pins.get(documentId)! })),
          candidates: candidates.map((candidate, index) => ({ index, length: candidate.length, templateSegments: candidate.templateSegments })),
        };
        const index = input.productIndex ?? (candidates.length === 1 ? 0 : undefined);
        if (index === undefined) return toolSuccess({ ...evidence, saved: false, selectionRequired: candidates.length > 1 });
        const candidate = candidates[index];
        if (!candidate) throw new Error('The selected PCR product index does not exist.');
        const name = normalizeEmptyDnaSequenceName(input.name);
        const product = composeSequenceProduct(name, false, candidate.parts, sources);
        const creationDerivation: SequenceProductCreation = {
          schema: 'dnaforge.sequence-product-creation.v1', circular: false,
          parts: candidate.parts.map(part => part.kind === 'source' ? { ...part, revision: pins.get(part.documentId)! } : part),
        };
        context.abortSignal?.throwIfAborted();
        mutationStarted = true;
        const saved = await createDnaSequencePackage({ name, destinationPath: resolveWorkspacePath(selected.path, input.directory), content: serializeGenBank(product), creationDerivation, requireAccepted: true, open: false });
        if (!saved.publication) throw new Error('The native writer did not return an accepted PCR product.');
        const documentId = saved.publication.accepted.resourceId;
        return toolSuccess({ ...evidence, saved: true, selectedProductIndex: index, documentId, resourceUri: `waypoint://sequence/${encodeURIComponent(documentId)}`, name, length: product.length, sequenceSha256: defineBlob(new TextEncoder().encode(product.sequence)).hash, acceptedRevision: saved.publication.accepted, creationDerivation, gitCommitted: saved.committed });
      } catch (error) {
        if (error instanceof SequenceCreationPendingError) return toolFailure({ code: 'PCR_PRODUCT_PUBLICATION_PENDING', error: error.message, retriable: false, stateChanged: true, partialEffects: [{ acceptedRevision: error.accepted, documentId: error.creation.resourceId }], details: { instruction: 'The PCR product was accepted. Inspect it and pending delivery before creating another molecule.' } });
        return toolFailure({ code: 'PCR_PRODUCT_CREATION_FAILED', error: error instanceof Error ? error.message : String(error), retriable: false, stateChanged: mutationStarted ? 'unknown' : false, partialEffects: [] });
      }
    },
  });
}
