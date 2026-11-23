import type Database from 'better-sqlite3';
import type { MolecularDocumentLocation } from '../shared/molecular-document';
import { MolecularDocumentLibrary } from './molecular-document-library';
import { createRegisteredProjectAuthority } from './registered-project-authority';

const library = new MolecularDocumentLibrary();

export async function readRegisteredMolecularDocument(
  db: Database.Database,
  location: MolecularDocumentLocation
) {
  const authority = createRegisteredProjectAuthority({ db: () => db });
  const project = authority.resolve(location.workspaceRoot);
  if (!project) throw new Error('PROJECT_ACCESS_DENIED');
  const assertCurrent = authority.capture(project.projectId);
  const saved = await library.read(location);
  assertCurrent();
  return saved;
}
