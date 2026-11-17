import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { computeChecksum } from '@waypoint/sequence-utils';
import { parseSequencePackageDocument, sequencePackagePaths } from '../../db/sequence-package';
import { parseSequenceFileAsDocument } from '../../shared/parse-sequence-file';

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export async function publishRerunSequenceRevision(
  workspaceRoot: string,
  input: {
    packageRoot: string;
    productContent: string;
    expected?: {
      packageRoot: string;
      packageId: string;
      markerSha256: string;
      productSha256: string;
    };
  }
): Promise<void> {
  const markerContent = await readFile(sequencePackagePaths(input.packageRoot).metaPath, 'utf8');
  const current = parseSequencePackageDocument(markerContent);
  const productPath = sequencePackagePaths(input.packageRoot, {
    productFile: current.product.file,
  }).productPath;
  const currentProduct = await readFile(productPath, 'utf8');
  if (
    input.expected &&
    (input.packageRoot !== input.expected.packageRoot ||
      current.id !== input.expected.packageId ||
      sha256(markerContent) !== `sha256:${input.expected.markerSha256}` ||
      sha256(currentProduct) !== `sha256:${input.expected.productSha256}`)
  )
    throw new Error('The previously migrated sequence changed before its arrival could be saved.');
  if (currentProduct === input.productContent) return;
  const sequence = parseSequenceFileAsDocument(input.productContent, productPath).sequence;
  const operation = randomUUID();
  const { publishSequencePackageRevisionInMain } =
    await import('../sequence-package-revision-publication');
  await publishSequencePackageRevisionInMain({
    workspaceRoot,
    packageRoot: input.packageRoot,
    packageId: current.id,
    nextDocument: {
      ...current,
      product: {
        ...current.product,
        topology: sequence.circular ? 'circular' : 'linear',
        sequenceChecksum: await computeChecksum(sequence.sequence),
        genBankChecksum: await computeChecksum(input.productContent),
      },
      updatedAt: new Date().toISOString(),
    },
    nextProductContent: input.productContent,
    kind: 'sequence-save',
    operationId: `outside-file:${operation}`,
    revisionId: `sequence-save:${operation}`,
    adoptedRevisionId: `adopted:${operation}`,
    expectedMarkerSha256: sha256(markerContent),
    expectedProductSha256: sha256(currentProduct),
  });
}
