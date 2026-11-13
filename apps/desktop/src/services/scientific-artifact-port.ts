import { platform } from '../platform';
import { readPrimerById } from '../shared/primer-artifacts/primer-repository';
import type { ScientificArtifactPort } from '../shared/scientific-artifact-port';
import { readScientificNamespace } from './read-scientific-namespace';
import { readScientificText } from '../features/scientific-document/services/read-scientific-text';
import { publishNativeArtifact } from './publish-native-artifact';
import { scientificRelationshipGitPaths } from './scientific-git-projections';

export const scientificArtifactPort: ScientificArtifactPort = {
  namespace: readScientificNamespace,
  readText: readScientificText,
  publish: publishNativeArtifact,
  primerById: async (id) => readPrimerById(platform().db, id),
  relationshipGitPaths: scientificRelationshipGitPaths,
};
