import { stat } from 'node:fs/promises';
import {
  isCustomGeneticCodeSpec,
  validateCustomGeneticCode,
  type CustomGeneticCodeDefinition,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import { SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME } from '../db/sequence-package-contract';
import {
  parseSequencePackageDocument,
  sequencePackagePaths,
  type SequencePackageDocument,
} from '../db/sequence-package';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { canonicalWorkspacePath } from './primer-artifact-files';

const METADATA_TRANSACTION_SCHEMA = 'waypoint.sequence-metadata-transaction.v1' as const;
const MAX_LEGACY_METADATA_TRANSACTION_BYTES = 4 * 1024 * 1024;

export type LegacySequenceMetadataTransaction =
  | {
      schema: typeof METADATA_TRANSACTION_SCHEMA;
      state: 'pending';
      packageId: string;
      targetDocument: SequencePackageDocument;
      targetGeneticCode?: GeneticCodeSpec | null;
      applyLocus?: boolean;
      locusName?: string;
      applyTopology?: boolean;
    }
  | {
      schema: typeof METADATA_TRANSACTION_SCHEMA;
      state: 'complete';
      packageId: string;
      completedAt: string;
    };

export function legacySequenceMetadataTransactionPath(packageRoot: string): string {
  return `${sequencePackagePaths(packageRoot).metaDir}/${SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME}`;
}

export function parseLegacySequenceMetadataTransaction(
  content: string
): LegacySequenceMetadataTransaction {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sequence metadata transaction must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== METADATA_TRANSACTION_SCHEMA || typeof record.packageId !== 'string') {
    throw new Error('Sequence metadata transaction identity is invalid.');
  }
  if (record.state === 'complete' && typeof record.completedAt === 'string') {
    return {
      schema: METADATA_TRANSACTION_SCHEMA,
      state: 'complete',
      packageId: record.packageId,
      completedAt: record.completedAt,
    };
  }
  if (record.state !== 'pending') {
    throw new Error('Sequence metadata transaction state is invalid.');
  }
  const geneticCode = record.targetGeneticCode;
  const validGeneticCode =
    geneticCode === null ||
    (typeof geneticCode === 'number' && Number.isInteger(geneticCode)) ||
    (isCustomGeneticCodeSpec(geneticCode as GeneticCodeSpec) &&
      validateCustomGeneticCode(geneticCode as CustomGeneticCodeDefinition).length === 0);
  return {
    schema: METADATA_TRANSACTION_SCHEMA,
    state: 'pending',
    packageId: record.packageId,
    targetDocument: parseSequencePackageDocument(JSON.stringify(record.targetDocument)),
    ...(validGeneticCode ? { targetGeneticCode: geneticCode as GeneticCodeSpec | null } : {}),
    ...(record.applyLocus === false ? { applyLocus: false } : {}),
    ...(typeof record.locusName === 'string' && record.locusName.trim()
      ? { locusName: record.locusName.trim() }
      : {}),
    ...(record.applyTopology === true ? { applyTopology: true as const } : {}),
  };
}

export async function readLegacySequenceMetadataJournalInMain(
  workspaceRoot: string,
  packageRoot: string
): Promise<{ transaction: LegacySequenceMetadataTransaction; content: string } | null> {
  const path = legacySequenceMetadataTransactionPath(packageRoot);
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const safe = await canonicalWorkspacePath({
    workspaceRoot,
    path,
    artifactNoun: 'sequence metadata transaction',
  });
  const bytes = await readFileBoundedFromHandle(
    safe.candidate,
    MAX_LEGACY_METADATA_TRANSACTION_BYTES
  );
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { transaction: parseLegacySequenceMetadataTransaction(content), content };
}

export async function assertLegacySequenceMetadataTransactionSettledInMain(
  workspaceRoot: string,
  packageRoot: string
): Promise<void> {
  let journal: Awaited<ReturnType<typeof readLegacySequenceMetadataJournalInMain>>;
  try {
    journal = await readLegacySequenceMetadataJournalInMain(workspaceRoot, packageRoot);
  } catch (cause) {
    throw new Error(
      'The sequence package requires legacy metadata recovery because its journal could not be verified.',
      { cause }
    );
  }
  if (journal?.transaction.state === 'pending') {
    throw new Error(
      'The sequence package requires legacy metadata recovery before a new revision can be published.'
    );
  }
}
