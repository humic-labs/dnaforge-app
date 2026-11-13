import { assertCanonicalSequenceSource } from '../sequence/public/sequence-document-repository';
import { ensureSequenceIdentity } from '../../db/sequence-identity';
import { platform } from '../../platform';
import {
  getCatalogEntityForFilePath,
  inferCatalogFileKind,
  registerWorkspaceFile,
} from '../../db/workspace-catalog';
import { createDnaSequenceOwner } from './dna-sequence-owner';
export * from './dna-sequence-owner';
const owner = createDnaSequenceOwner({
  assertCanonicalSequenceSource,
  ensureSequenceIdentity,
  io: platform,
  getCatalogEntityForFilePath,
  inferCatalogFileKind,
  registerWorkspaceFile,
});
export const { resolveDnaSequence, buildFileDnaSequenceSnapshot, buildFileDnaSequenceRef } = owner;
