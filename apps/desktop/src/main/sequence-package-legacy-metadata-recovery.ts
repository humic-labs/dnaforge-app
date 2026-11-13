import type { RegisteredSequencePackagePublicationContext } from './sequence-package-registry-publication';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { updateGenBankGeneticCodeComment } from '@waypoint/sequence-utils';
import {
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { updateGenBankLocusMetadata } from '../shared/genbank-locus-metadata';
import {
  legacySequenceMetadataTransactionPath,
  readLegacySequenceMetadataJournalInMain,
} from './sequence-package-legacy-metadata-journal';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { withRecoveredSequencePackageMutationInMain } from './sequence-package-revision-publication';

export async function recoverLegacySequenceMetadataTransactionInMain(
  workspaceRoot: string,
  packageRoot: string,
  hooks: { afterProductWrite?: () => Promise<void> } = {},
  suppliedContext?: RegisteredSequencePackagePublicationContext
): Promise<void> {
  await withRecoveredSequencePackageMutationInMain(
    workspaceRoot,
    packageRoot,
    async () => {
      const journal = await readLegacySequenceMetadataJournalInMain(workspaceRoot, packageRoot);
      if (!journal || journal.transaction.state === 'complete') return;
      const transaction = journal.transaction;
      const target = transaction.targetDocument;
      if (target.id !== transaction.packageId) {
        throw new Error(
          'Sequence metadata transaction package identity does not match its target.'
        );
      }
      const paths = sequencePackagePaths(packageRoot, { productFile: target.product.file });
      const liveMarkerContent = await readContained(workspaceRoot, paths.metaPath);
      const liveMarker = parseSequencePackageDocument(liveMarkerContent);
      if (
        liveMarker.id !== transaction.packageId ||
        liveMarker.product.file !== target.product.file
      ) {
        throw new Error(
          'Pending legacy metadata recovery conflicts with the live package identity or product file.'
        );
      }
      if (
        liveMarker.versionHistory.headId !== null &&
        JSON.stringify(liveMarker) !== JSON.stringify(target)
      ) {
        throw new Error(
          'Pending legacy metadata recovery conflicts with a newer sequence revision. No package files were changed.'
        );
      }
      const currentProduct = await readContained(workspaceRoot, paths.productPath);
      const legacyLocusRewrite =
        transaction.applyLocus !== false &&
        transaction.locusName === undefined &&
        transaction.applyTopology !== true;
      const withLocus = legacyLocusRewrite
        ? updateGenBankLocusMetadata(currentProduct, {
            name: target.name,
            topology: target.product.topology,
          })
        : transaction.locusName || transaction.applyTopology
          ? updateGenBankLocusMetadata(currentProduct, {
              ...(transaction.locusName ? { name: transaction.locusName } : {}),
              ...(transaction.applyTopology && target.product.topology
                ? { topology: target.product.topology }
                : {}),
            })
          : currentProduct;
      const targetProduct =
        transaction.targetGeneticCode === undefined
          ? withLocus
          : updateGenBankGeneticCodeComment(withLocus, transaction.targetGeneticCode);
      await replaceIfChanged(workspaceRoot, paths.productPath, currentProduct, targetProduct);
      await hooks.afterProductWrite?.();
      await replaceIfChanged(
        workspaceRoot,
        paths.metaPath,
        liveMarkerContent,
        serializeSequencePackageDocument(target)
      );
      const journalPath = legacySequenceMetadataTransactionPath(packageRoot);
      await replaceIfChanged(
        workspaceRoot,
        journalPath,
        journal.content,
        `${JSON.stringify(
          {
            schema: 'waypoint.sequence-metadata-transaction.v1',
            state: 'complete',
            packageId: target.id,
            completedAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`
      );
    },
    suppliedContext
  );
}

async function readContained(workspaceRoot: string, path: string): Promise<string> {
  const safe = await canonicalWorkspacePath({
    workspaceRoot,
    path,
    artifactNoun: 'sequence metadata transaction',
  });
  return readFile(safe.candidate, 'utf8');
}

async function replaceIfChanged(
  workspaceRoot: string,
  path: string,
  before: string,
  after: string
): Promise<void> {
  if (before === after) return;
  await writeWorkspaceTextFileAtomicInMain(
    {
      workspaceRoot,
      path,
      content: after,
      mode: 'replace',
      expectedContentHash: createHash('sha256').update(before).digest('hex'),
      artifactNoun: 'sequence metadata transaction',
    },
    { durable: true }
  );
}
