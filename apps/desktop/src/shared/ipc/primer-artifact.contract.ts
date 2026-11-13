import { defineGroup, invoke } from './contract';
import type {
  PrimerArtifactRevisionStateRequest,
  PrimerArtifactRevisionState,
  PrimerArtifactRevisionCommand,
  PrimerArtifactRevisionResult,
  PrimerArtifactPublicationResumeRequest,
} from '../primer-artifact-revision';

export const primerArtifactContract = defineGroup('lims', {
  readPrimerArtifactRevisionState: invoke<
    [request: PrimerArtifactRevisionStateRequest],
    PrimerArtifactRevisionState
  >(),
  revisePrimerArtifact: invoke<
    [request: PrimerArtifactRevisionCommand],
    PrimerArtifactRevisionResult
  >(),
  resumePrimerArtifactPublication: invoke<
    [request: PrimerArtifactPublicationResumeRequest],
    PrimerArtifactRevisionResult
  >(),
});
