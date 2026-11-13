import { recordEntityArtifact } from '../lims/public/record-entity-artifact';
import { queryLimsEntities } from '../lims/public/operations';
import { createProteinArtifactOwner } from './protein-artifact-owner';
export * from './protein-artifact-owner';
const owner = createProteinArtifactOwner({ recordEntityArtifact, queryLimsEntities });
export const {
  validateProteinArtifactPath,
  sanitizeProteinFileStem,
  recordProtein,
  previewProteinArtifactPath,
} = owner;
