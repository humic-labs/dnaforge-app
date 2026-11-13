import { platform } from '../platform';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import { readScientificNamespace } from './read-scientific-namespace';

export async function copyAcceptedScientificPath(input: {
  workspaceRoot: string;
  sourcePath: string;
  destinationPath: string;
  mutationToken?: string;
}): Promise<boolean> {
  const source = pathRelativeToBoundary(input.sourcePath, input.workspaceRoot);
  const destinationPath = pathRelativeToBoundary(input.destinationPath, input.workspaceRoot);
  if (!source || !destinationPath) throw new Error('The copy must stay inside its owning project.');
  const namespace = await readScientificNamespace(input.workspaceRoot);
  if (!namespace) return false;
  const candidates = namespace.entries.filter(
    (slot) =>
      !slot.tombstone &&
      slot.path &&
      (slot.path === source ||
        (slot.path.startsWith(`${source}/`) &&
          !slot.path.slice(source.length + 1).includes('/') &&
          /\.(?:gb|gbk|genbank)$/iu.test(slot.path)))
  );
  for (const candidate of candidates) {
    const snapshot = await platform().scientificObjects.read({
      workspaceRoot: input.workspaceRoot,
      request: { workspace: namespace.workspace, resourceId: candidate.resourceId },
    });
    if (!snapshot || !['primer', 'sequence', 'strain'].includes(snapshot.document.kind)) continue;
    let catalogNumber: string | undefined;
    if (snapshot.representation?.format === 'primer-v2') {
      const owners = await platform().db.select<Array<{ id: number }>>(
        'SELECT id FROM workspaces WHERE path=?',
        [input.workspaceRoot]
      );
      if (owners.length !== 1) throw new Error('The copied primer has no unique owning project.');
      catalogNumber = await platform().db.allocatePrimerCatalogNumber(
        owners[0].id,
        input.workspaceRoot,
        input.mutationToken
      );
    }
    const result = await platform().scientificObjects.submit({
      workspaceRoot: input.workspaceRoot,
      request: {
        workspace: namespace.workspace,
        operationId: `scientific-copy:${crypto.randomUUID()}`,
        expectedHead: namespace.head,
        source: {
          kind: 'copy',
          resourceId: candidate.resourceId,
          destinationPath,
          copiedAt: new Date().toISOString(),
          ...(catalogNumber ? { catalogNumber } : {}),
        },
      },
      ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
    });
    if (result.receipt.outcome !== 'changed' && result.receipt.outcome !== 'no-op')
      throw new Error('The scientific copy was not accepted. Refresh before retrying.');
    if (result.delivery?.kind !== 'complete')
      throw new Error(
        `Copy accepted; file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`
      );
    return true;
  }
  return false;
}
