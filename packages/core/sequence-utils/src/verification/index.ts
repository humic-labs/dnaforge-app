export { SIDECAR_VERSION } from './types';
export type {
  SidecarType,
  VerificationStatus,
  VerificationReference,
  VerificationResultSummary,
  VerificationMutation,
  VerificationAlignment,
  VerificationInput,
  VerificationResult,
  VerificationOptions,
  MatchCriteria,
  ReferenceMatch,
  BatchVerificationInput,
  BatchVerificationResult,
} from './types';

export {
  SIDECAR_EXTENSION,
  getSidecarPath,
  isSidecarPath,
  getSourcePath,
  serializeSidecar,
  parseSidecar,
  computeChecksum,
  matchesSequenceChecksumIgnoringCase,
  verifyChecksum,
  createRelativePath,
  resolveRelativePath,
  createVerificationResult,
  summarizeVerification,
} from './sidecar';
export type { VerificationSummary } from './sidecar';
