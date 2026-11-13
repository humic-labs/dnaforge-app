import { z } from 'zod';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { defineBlob } from '@waypoint/workspace-revisions';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { composeSequenceProduct, createSequenceProductSchema, type SequenceProductCreation } from '../../../shared/sequence-product';
import { createDnaSequencePackage, normalizeEmptyDnaSequenceName, SequenceCreationPendingError } from '../../sequence/public/create-empty-dna-sequence';
import { readAcceptedDnaSources } from './sequence-product-sources';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { getUserFolders, normalizeSequenceDocumentId, resolveWorkspacePath } from './path-utils';

export { createSequenceProductSchema } from '../../../shared/sequence-product';

export function createCreateSequenceProductTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Save an exact planned DNA product from ordered source ranges and explicit synthetic DNA. ' +
      'Use this for chromosome insertion alleles, marker-recycled alleles, fragments or predicted verification products. ' +
      'The product is a new accepted sequence with immutable source revisions and a creation recipe; originals are unchanged. ' +
      'This concatenates the specified bases exactly: it does not design primers, trim overlaps, simulate recombination or validate the biology. ' +
      'Choose and justify the biological boundaries yourself. Import original files with import_sequence first and use its returned documentId. ' +
      'Fully retained source features are mapped into the product; features cut by a part boundary are omitted. ' +
      'Read the result with get_sequence and link chromosome products using create_strain relationships.',
    inputSchema: createSequenceProductSchema,
    execute: async (input: z.infer<typeof createSequenceProductSchema>, context) => {
      let mutationStarted = false;
      try {
        const roots = getUserFolders(folders);
        const selected = input.workspace ? resolveExplicitProjectRoot(roots, input.workspace) : roots.length === 1 ? roots[0] : undefined;
        if (!selected) throw new Error('Select one open project, providing workspace when multiple projects are open.');
        const parts = input.parts.map((part) => part.kind === 'source' ? { ...part, documentId: normalizeSequenceDocumentId(part.documentId) } : part);
        const { sources, pins } = await readAcceptedDnaSources(selected.path, parts.filter(part => part.kind === 'source').map(part => part.documentId), context.abortSignal);
        const name = normalizeEmptyDnaSequenceName(input.name);
        const product = composeSequenceProduct(name, input.circular, parts, sources);
        const creationDerivation: SequenceProductCreation = {
          schema: 'dnaforge.sequence-product-creation.v1',
          circular: input.circular,
          parts: parts.map((part) => part.kind === 'source' ? { ...part, revision: pins.get(part.documentId)! } : part),
        };
        context.abortSignal?.throwIfAborted();
        mutationStarted = true;
        const saved = await createDnaSequencePackage({
          name,
          destinationPath: resolveWorkspacePath(selected.path, input.directory),
          content: serializeGenBank(product),
          creationDerivation,
          requireAccepted: true,
          open: false,
        });
        if (!saved.publication) throw new Error('The native writer did not return an accepted sequence product.');
        const documentId = saved.publication.accepted.resourceId;
        return toolSuccess({
          saved: true,
          planned: true,
          documentId,
          resourceUri: `waypoint://sequence/${encodeURIComponent(documentId)}`,
          name,
          length: product.length,
          circular: product.circular,
          sequenceSha256: defineBlob(new TextEncoder().encode(product.sequence)).hash,
          acceptedRevision: saved.publication.accepted,
          creationDerivation,
          gitCommitted: saved.committed,
        });
      } catch (error) {
        if (error instanceof SequenceCreationPendingError)
          return toolFailure({ code: 'SEQUENCE_PRODUCT_PUBLICATION_PENDING', error: error.message, retriable: false, stateChanged: true, partialEffects: [{ acceptedRevision: error.accepted, documentId: error.creation.resourceId }], details: { instruction: 'The product was accepted. Inspect the existing product and pending delivery before creating another molecule.' } });
        return toolFailure({ code: error instanceof Error && 'code' in error && error.code === 'SEQUENCE_SOURCE_NOT_ACCEPTED' ? 'SEQUENCE_SOURCE_NOT_ACCEPTED' : 'SEQUENCE_PRODUCT_CREATION_FAILED', error: error instanceof Error ? error.message : String(error), retriable: false, stateChanged: mutationStarted ? 'unknown' : false, partialEffects: [] });
      }
    },
  });
}
