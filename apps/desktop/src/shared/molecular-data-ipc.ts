import { z } from 'zod';
import { molecularDatasetSchema, molecularDataMappingSchema } from './molecular-data';

const scope = z.string().min(1).max(64_000);
export const molecularDataRetainSchema = z
  .object({
    workspaceScope: scope,
    dataset: molecularDatasetSchema,
    mapping: molecularDataMappingSchema,
  })
  .strict();
export type MolecularDataRetainInput = z.infer<typeof molecularDataRetainSchema>;
export const molecularDataLoadSchema = z
  .object({
    workspaceScope: scope,
    datasetReferenceId: z.string().regex(/^molecular-dataset:[0-9a-f]{64}$/),
    mappingReferenceId: z.string().regex(/^molecular-mapping:[0-9a-f]{64}$/),
  })
  .strict();
export type MolecularDataLoadInput = z.infer<typeof molecularDataLoadSchema>;
export type MolecularDataRetained = Pick<
  MolecularDataLoadInput,
  'datasetReferenceId' | 'mappingReferenceId'
>;
export type MolecularDataLoaded = Pick<MolecularDataRetainInput, 'dataset' | 'mapping'>;
export interface MolecularDataAPI {
  retain(input: MolecularDataRetainInput): Promise<MolecularDataRetained>;
  load(input: MolecularDataLoadInput): Promise<MolecularDataLoaded>;
}
