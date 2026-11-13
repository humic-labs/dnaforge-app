import { platform } from '../platform';
import { registerWorkspaceFile } from '../db/workspace-catalog';

const stripTrailer = (p: string) => p.replace(/[\\/]+$/, '');
const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/');

export async function nextAvailableFolderName(
  parentPath: string,
  isTaken: (path: string) => boolean | Promise<boolean>
): Promise<{ name: string; path: string } | null> {
  const parent = stripTrailer(parentPath);
  const sep = sepOf(parent);
  for (let index = 1; index <= 100; index++) {
    const name = index === 1 ? 'New Folder' : `New Folder ${index}`;
    const path = `${parent}${sep}${name}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await isTaken(path))) return { name, path };
  }
  return null;
}

export async function createFolderArtifact(opts: {
  path: string;
  name: string;
  parentPath: string;
  workspaceRoot: string | null;
  createdBy: string;
  mutationToken?: string;
}): Promise<void> {
  await platform().fs.mkdir(opts.path, undefined, opts.mutationToken);
  await registerWorkspaceFile({
    path: opts.path,
    name: opts.name,
    entityType: 'folder',
    fileKind: 'folder',
    workspaceRoot: opts.workspaceRoot,
    metadata: { createdBy: opts.createdBy, parentPath: opts.parentPath },
    mutationToken: opts.mutationToken,
  }).catch((err) => {
    console.warn('[folder-create] Failed to register folder in catalog:', err);
  });
}
