import { platform } from '../platform';
import { createSequenceIdentityRepository } from './sequence-identity-repository';
const repository = () => createSequenceIdentityRepository(platform().db);
export const ensureSequenceIdentity: ReturnType<
  typeof createSequenceIdentityRepository
>['ensureSequenceIdentity'] = (...args) => repository().ensureSequenceIdentity(...args);
export const getSequenceIdByDocumentId: ReturnType<
  typeof createSequenceIdentityRepository
>['getSequenceIdByDocumentId'] = (...args) => repository().getSequenceIdByDocumentId(...args);
