import { primerRecoveryServices } from '../../services/primer-recovery-services';
import { scientificArtifactPort } from '../../services/scientific-artifact-port';
import { platform } from '../../platform';
import { buildFileDnaSequenceRef, buildInlineDnaSequenceRef } from '../lims/public/dna-sequence';
import {
  archiveLimsEntity,
  queryLimsEntities,
  registerLimsEntity,
  restoreLimsEntity,
  updateLimsEntity,
} from '../lims/public/operations';
import { generateCatalogNumber } from './auto-numbering';
import { gitCommitPaths, gitStatus, isGitRepo } from '../workspace/public/git';
import { cooperateWithRendererInteraction } from '../../lib/renderer-interaction-activity';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogFileForPath,
  markCatalogFileHistorical,
  markCatalogFileMissing,
  releaseMissingCatalogFilePath,
  registerCatalogEntity,
} from '../../db/workspace-catalog';
import { primerTmCalculationService } from './primer-tm-service';
import { resolveSequenceDocumentById } from '../sequence/public/sequence-document-repository';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { createPrimerArtifactOwner } from './primer-artifact-owner';
export * from './primer-artifact-owner';
const owner = createPrimerArtifactOwner({
  recovery: primerRecoveryServices,
  archiveLimsEntity,
  scientific: scientificArtifactPort,
  io: platform,
  buildFileDnaSequenceRef,
  buildInlineDnaSequenceRef,
  queryLimsEntities,
  registerLimsEntity,
  restoreLimsEntity,
  updateLimsEntity,
  generateCatalogNumber,
  gitCommitPaths,
  gitStatus,
  isGitRepo,
  cooperateWithRendererInteraction,
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogFileForPath,
  markCatalogFileHistorical,
  markCatalogFileMissing,
  releaseMissingCatalogFilePath,
  registerCatalogEntity,
  primerTmCalculationService,
  resolveSequenceDocumentById,
  withRendererWorkspaceMutation,
});
export const {
  deletePrimerArtifact,
  isFileAuthoritativePrimerInput,
  prepareUnboundPrimerArtifact,
  writeAndProjectPrimerArtifact,
  savePrimerArtifact,
  reconcilePrimerArtifact,
  reconcilePrimerArtifactsInWorkspace,
  attachPrimerArtifact,
  readSavedPrimerBindingTarget,
  persistOwnedPrimerArtifactBindings,
  updatePrimerArtifactBinding,
  detachPrimerArtifact,
  readPrimerArtifactForPrimer,
  retireTrashedPrimerArtifact,
  trashPrimerArtifact,
  readPrimerArtifactAtPath,
  updatePrimerArtifactContent,
  resumePrimerArtifactSave,
  projectPrimerArtifact,
  resolvePrimerBindings,
  commitPrimerBatchHistory,
  currentDirtyLimsPaths,
  primerArtifactRelativePath,
} = owner;
