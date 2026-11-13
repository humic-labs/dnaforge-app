import { platform } from '../platform';
import { readScientificNamespace } from './read-scientific-namespace';
import { createScientificRelationshipGitReader } from '../shared/scientific-relationship-git';
export const scientificRelationshipGitPaths = createScientificRelationshipGitReader({
  namespace: readScientificNamespace,
  files: {
    exists: (path) => platform().fs.exists(path),
    readTextFile: (path) => platform().fs.readTextFile(path),
  },
  read: (input) => platform().scientificObjects.read(input),
});
