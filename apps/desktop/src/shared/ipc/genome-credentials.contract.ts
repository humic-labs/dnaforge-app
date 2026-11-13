import type {
  GenomeSourceCredentialInput,
  GenomeSourceCredentialRemovalResult,
  GenomeSourceCredentialStatus,
  GenomeSourceCredentialSummary,
} from '../genome-source-credentials';
import { defineGroup, invoke } from './contract';

export const genomeCredentialsContract = defineGroup('genomeCredentials', {
  save: invoke<[input: GenomeSourceCredentialInput], GenomeSourceCredentialSummary>(),
  status: invoke<[authRef: string], GenomeSourceCredentialStatus>(),
  prepare: invoke<[authRef: string], GenomeSourceCredentialSummary>(),
  remove: invoke<[authRef: string], GenomeSourceCredentialRemovalResult>(),
});
