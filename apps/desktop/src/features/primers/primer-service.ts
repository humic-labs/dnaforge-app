import { createPrimerApplicationOwner } from '../../shared/primer-artifacts/primer-application-owner';
import * as artifacts from './primer-artifact-service';
import { getCatalogFilesForEntity } from '../../db/workspace-catalog';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { buildFileDnaSequenceRef } from '../lims/public/dna-sequence';
import { queryLimsEntities } from '../lims/public/operations';
import { platform } from '../../platform';
import { primerTmCalculationService } from './primer-tm-service';
import { generateCatalogNumber } from './auto-numbering';
import { createPrimerRepository } from './primer-repository';
export * from './primer-repository';
const repository = () =>
  createPrimerRepository({
    database: platform().db,
    primerTmCalculationService,
    generateCatalogNumber,
  });
const application = () =>
  createPrimerApplicationOwner({
    io: platform,
    repository: repository(),
    artifacts,
    catalog: { getCatalogFilesForEntity },
    tm: primerTmCalculationService,
    withRendererWorkspaceMutation,
    buildFileDnaSequenceRef,
    queryLimsEntities,
  });
export const createPrimer: ReturnType<typeof createPrimerApplicationOwner>['createPrimer'] = (
  ...args
) => application().createPrimer(...args);
export const updatePrimer: ReturnType<typeof createPrimerApplicationOwner>['updatePrimer'] = (
  ...args
) => application().updatePrimer(...args);
export const deletePrimer: ReturnType<typeof createPrimerApplicationOwner>['deletePrimer'] = (
  ...args
) => application().deletePrimer(...args);
export const searchPrimers: ReturnType<typeof createPrimerRepository>['searchPrimers'] = (
  ...args
) => repository().searchPrimers(...args);
export const getPrimerById: ReturnType<typeof createPrimerRepository>['getPrimerById'] = (
  ...args
) => repository().getPrimerById(...args);
export const createBinding: ReturnType<typeof createPrimerApplicationOwner>['createBinding'] = (
  ...args
) => application().createBinding(...args);
export const deleteBinding: ReturnType<typeof createPrimerApplicationOwner>['deleteBinding'] = (
  ...args
) => application().deleteBinding(...args);
export const listBoundPrimers: ReturnType<typeof createPrimerRepository>['listBoundPrimers'] = (
  ...args
) => repository().listBoundPrimers(...args);
export const importBatch: ReturnType<typeof createPrimerApplicationOwner>['importBatch'] = (
  ...args
) => application().importBatch(...args);

export const persistOwnedPrimerBinding: ReturnType<
  typeof createPrimerApplicationOwner
>['persistOwnedPrimerBinding'] = (...args) => application().persistOwnedPrimerBinding(...args);
