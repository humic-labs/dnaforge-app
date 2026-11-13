import { z } from 'zod';
import { platform } from '../../../platform';
import { encodedMoleculeSchema, molecularCatalogRegisterSchema, molecularCatalogListSchema } from '../../../shared/molecular-catalog';
import { canonicalEncodedMolecule } from '../../../shared/encoded-molecule';
import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { attachCatalogToInspection } from '../../structure-drawer/public/inspection-catalog';
import { loadCatalogStructure, openCatalogStructure, registerCatalogStructure } from '../../compute/public/molecular-catalog';

const molecularStructureActionSchema = z.discriminatedUnion('operation', [
  molecularCatalogRegisterSchema.extend({ operation: z.literal('register') }),
  molecularCatalogListSchema.extend({ operation: z.literal('list') }),
  z.object({ operation: z.literal('mapping'), observationId: z.string().regex(/^[a-f0-9]{64}$/), chainKey: z.string().min(1).max(4096), molecule: encodedMoleculeSchema.optional() }).strict(),
  z.object({ operation: z.literal('open'), observationId: z.string().regex(/^[a-f0-9]{64}$/), chainKey: z.string().optional(), documentId: z.string().optional() }).strict(),
]);



export const molecularStructuresSchema = z.object({
  ...molecularCatalogRegisterSchema.partial().shape,
  ...molecularCatalogListSchema.partial().shape,
  operation: z.enum(['register', 'list', 'mapping', 'open']),
  observationId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  chainKey: z.string().min(1).max(4096).optional(),
  documentId: z.string().optional(),
}).strict();
export const MOLECULAR_STRUCTURES_DESCRIPTION = 'Register, find and open reusable structures across all documents and workspaces. register takes workspaceRoot, filePath (PDB/mmCIF/BinaryCIF), optional full typed molecules, and source:{kind:"import",uri?} or source:{kind:"prediction",jobRecordId}. Predictions are verified against the native compute run and actual provider output; do not relabel imported coordinates as a prediction. list takes optional molecule:{kind:"protein"|"rna"|"dna",sequence:fullEncodedSequence}, requestHash for the complete client request, and providerRequestHash for the actual reported normalized inputs/model/version. Missing request evidence cannot match these hashes; undocumented defaults stay unknown; returns distinct import/run observations, original source chains/models, exact/partial/homolog relationships and coordinate coverage. mapping takes observationId, chainKey from list and optional molecule; returns the original chain inventory, immutable source/run provenance and persisted molecule-to-residue mappings without coordinate bytes. Sequence positions are one-based, observedResidueIndex is zero-based in chain.observedResidues, and labelSequenceId/authorSequenceId/insertionCode identify physical residues for mol_data selectors. Missing geometry has no mapping entry. Modified residues retain their actual chemistry while matching known encoded parents. open takes observationId and optional chainKey from list. Add documentId to attach a chosen text coordinate chain to an already-open mutation inspection. It opens stored original coordinates without rerunning or contacting a provider. Use mol_list_structures, mol_get_scene and mol_data to apply arbitrary signals and save visual variations. Ambiguous/incomplete sequences cannot assert exact identity.';
export function createMolecularStructuresTool() {
  return resultTool({ description: MOLECULAR_STRUCTURES_DESCRIPTION, inputSchema: molecularStructuresSchema, execute: async (args) => {
    try {
      const input = molecularStructureActionSchema.parse(args);
      if (input.operation === 'register') { const { operation: _op, ...request } = input; return toolSuccess({ match: await registerCatalogStructure(request) }); }
      if (input.operation === 'list') { const { operation: _op, ...request } = input; return toolSuccess({ matches: await platform().molecularCatalog.list(request) }); }
      if (input.operation === 'mapping') {
        const loaded = await loadCatalogStructure(input.observationId);
        const chain = loaded.inventory.chains.find((item) => item.key === input.chainKey);
        if (!chain) throw new Error('The selected source chain was not found in this saved structure.');
        const molecule = input.molecule ? canonicalEncodedMolecule(input.molecule) : undefined;
        const mappings = loaded.mappings.filter((item) => item.chainKey === chain.key && (!molecule || (item.molecule.kind === molecule.kind && item.molecule.sequence === molecule.sequence)));
        return toolSuccess({ observation: loaded.observation, chain, mappings });
      }
      if (input.documentId) {
        if (!input.chainKey) throw new Error('A mutation inspection needs an exact chainKey from list.');
        await attachCatalogToInspection(input.documentId, input.observationId, input.chainKey);
        return toolSuccess({ documentId: input.documentId, observationId: input.observationId, chainKey: input.chainKey });
      }
      return toolSuccess({ opened: await openCatalogStructure(input.observationId, input.chainKey) });
    } catch (error) { return toolFailure({ code: 'MOLECULAR_CATALOG_ERROR', error: error instanceof Error ? error.message : String(error), retriable: false, stateChanged: 'unknown', partialEffects: [] }); }
  } });
}
