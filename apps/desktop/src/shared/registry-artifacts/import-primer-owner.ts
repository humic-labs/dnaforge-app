import type {
  createPrimerArtifactOwner,
  PrimerArtifactPersistencePort,
} from '../primer-artifacts/primer-artifact-owner';
import type {
  createPrimerRecorder,
  RecordablePrimer,
} from '../primer-artifacts/record-primers-owner';
import type { LimsImportPlan } from '../lims';
import { pathRelativeToBoundary } from '../path-boundary';
import {
  createBuiltinPrimerSchemaSnapshot,
  primerArtifactPathInDir,
  sha256Hex,
} from '../primer-artifacts/primer-artifact';
import { parseIdtOligoNotation } from '../primer-artifacts/oligo-modifications';

import { PRIMER_MANAGED_SCHEMA_FIELD_KEYS } from '../primer-artifacts/primer-schema-contract';

import type {
  PersistImportSetOperation,
  ImportSetMemberV1,
  ImportSetSourceInput,
} from './import-set-core';
export interface ImportedPrimerRecordSummary {
  added: number;
  skipped: number;
  failed: number;
  failures: { name: string; message: string }[];
  artifactRelativePaths: string[];
  importSet: { id: string; manifestRelativePath: string } | null;
  importSetError?: string;
  members: ImportSetMemberV1[];
  partition: ImportedPrimerImportPartition;
}

export interface ImportedPrimerImportPartition {
  plan: LimsImportPlan;
  members: ImportSetMemberV1[];
}

interface PlannedImportedPrimer {
  record: LimsImportPlan['records'][number];
  primer: RecordablePrimer;
  sourceRowId: string;
}

export type ImportedPrimerSourceInput = ImportSetSourceInput;
export interface createPrimerImportWriterDependencies {
  resolveEntitySchema?(
    kind: string
  ): Promise<import('../primer-artifacts/types').PrimerEntitySchemaSnapshot>;
  commitPrimerBatchHistory: ReturnType<
    typeof createPrimerArtifactOwner
  >['commitPrimerBatchHistory'];
  currentDirtyLimsPaths: ReturnType<typeof createPrimerArtifactOwner>['currentDirtyLimsPaths'];
  recordPrimers: ReturnType<typeof createPrimerRecorder>['recordPrimers'];
  primerServices: { persistence: Pick<PrimerArtifactPersistencePort, 'readArtifactAtPath'> };
  persistImportSet: PersistImportSetOperation;
}
export function createPrimerImportWriter(dependencies: createPrimerImportWriterDependencies) {
  const {
    commitPrimerBatchHistory,
    currentDirtyLimsPaths,
    recordPrimers,
    primerServices,
    persistImportSet,
  } = dependencies;
  async function oligoImportSourceRowId(
    record: LimsImportPlan['records'][number],
    dedupIdentity: string
  ): Promise<string> {
    if (record.externalRowId) return `external-${record.externalRowId}`;
    return `rowid-${(
      await sha256Hex(
        JSON.stringify([record.entityDraft.kind, record.entityDraft.name, dedupIdentity])
      )
    ).slice(0, 32)}`;
  }

  function isOligoImportKind(kind: string): kind is 'oligo' | 'rna_oligo' {
    return kind === 'oligo' || kind === 'rna_oligo';
  }

  function importedSequenceNotation(
    plan: LimsImportPlan,
    record: LimsImportPlan['records'][number],
    fallbackBases: string
  ): string {
    if (record.sequenceNotation?.trim()) return record.sequenceNotation.trim();
    const sequenceColumn = plan.columns?.find(
      (column) => column.mappingMode === 'mapped' && column.mappedField === 'fields.sequence'
    )?.sourceColumn;
    if (!sequenceColumn) return fallbackBases;
    const normalizedColumn = sequenceColumn.trim().toLowerCase();
    const sourceEntry = Object.entries(record.source).find(
      ([key]) => key.trim().toLowerCase() === normalizedColumn
    );
    return typeof sourceEntry?.[1] === 'string' && sourceEntry[1].trim()
      ? sourceEntry[1].trim()
      : fallbackBases;
  }

  function importedEntityFields(fields: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => !PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(key) && value !== undefined
      )
    );
  }

  async function plannedImportedPrimers(plan: LimsImportPlan): Promise<PlannedImportedPrimer[]> {
    const entries: PlannedImportedPrimer[] = [];
    for (const record of plan.records) {
      if (!record.accepted || record.action !== 'create') continue;
      if (!isOligoImportKind(plan.importFamily ?? record.entityDraft.kind)) continue;
      const seqRef = record.entityDraft.fields.sequence as
        | { mode?: string; bases?: unknown }
        | undefined;
      const fallbackBases =
        seqRef?.mode === 'inline' && typeof seqRef.bases === 'string' ? seqRef.bases.trim() : '';
      if (!fallbackBases) continue;
      const orderType =
        (plan.importFamily ?? record.entityDraft.kind) === 'rna_oligo' ? 'rna' : 'dna';
      const notation = importedSequenceNotation(plan, record, fallbackBases);
      const parsed = parseIdtOligoNotation(notation, { orderType });
      if (parsed.errors.length > 0 || !parsed.bases) continue;
      const entityFields = importedEntityFields(record.entityDraft.fields);
      const dedupIdentity = parsed.composition
        ? `${orderType}:${parsed.composition.notation}`
        : parsed.bases.toUpperCase();
      const stemHash = (await sha256Hex(dedupIdentity)).slice(0, 8);
      const primer: RecordablePrimer = {
        name: record.entityDraft.name,
        sequence: parsed.bases,
        ...(parsed.composition ? { oligo: parsed.composition } : {}),
        notes: typeof entityFields.notes === 'string' ? entityFields.notes : null,
        entitySchema:
          (await dependencies.resolveEntitySchema?.(record.entityDraft.kind)) ??
          createBuiltinPrimerSchemaSnapshot(orderType),
        entityFields,
        artifactStem: `${record.entityDraft.name}-${stemHash}`,
      };
      const sourceRowId = await oligoImportSourceRowId(record, dedupIdentity);
      entries.push({ record, primer, sourceRowId });
    }
    return entries;
  }

  async function plannedPrimersFromImport(plan: LimsImportPlan): Promise<RecordablePrimer[]> {
    return (await plannedImportedPrimers(plan)).map((entry) => entry.primer);
  }

  async function plannedPrimersForDestination(
    plan: LimsImportPlan,
    destinationDir: string
  ): Promise<RecordablePrimer[]> {
    return (await plannedPrimersFromImport(plan)).map((primer) => ({
      ...primer,
      artifactPath: primerArtifactPathInDir(destinationDir, primer.artifactStem ?? primer.name),
    }));
  }

  async function plannedImportedPrimersForDestination(
    plan: LimsImportPlan,
    destinationDir: string
  ): Promise<PlannedImportedPrimer[]> {
    return (await plannedImportedPrimers(plan)).map((entry) => ({
      ...entry,
      primer: {
        ...entry.primer,
        artifactPath: primerArtifactPathInDir(
          destinationDir,
          entry.primer.artifactStem ?? entry.primer.name
        ),
      },
    }));
  }

  async function persistImportedPrimerImportSet(input: {
    partitions: ImportedPrimerImportPartition[];
    workspaceRoot: string;
    destinationDir: string;
    source?: ImportedPrimerSourceInput;
    commitMessage?: string;
  }): Promise<{
    importSet: NonNullable<ImportedPrimerRecordSummary['importSet']>;
    relativePaths: string[];
  }> {
    const written = await persistImportSet({
      partitions: input.partitions,
      workspaceRoot: input.workspaceRoot,
      destinationDir: input.destinationDir,
      ...(input.source ? { source: input.source } : {}),
    });
    if (input.commitMessage) {
      await commitPrimerBatchHistory(
        input.workspaceRoot,
        written.relativePaths,
        new Set(),
        input.commitMessage
      );
    }
    return {
      importSet: written.importSet,
      relativePaths: written.relativePaths,
    };
  }

  async function recordImportedPrimers(
    plan: LimsImportPlan,
    destination: {
      workspaceRoot: string;
      destinationDir: string;
      source?: ImportedPrimerSourceInput;
      persistImportSet?: boolean;
    }
  ): Promise<ImportedPrimerRecordSummary> {
    const entries = await plannedImportedPrimersForDestination(plan, destination.destinationDir);
    const primers = entries.map((entry) => entry.primer);
    const limsBefore = await currentDirtyLimsPaths(destination.workspaceRoot);
    const result = await recordPrimers({
      primers,
      workspaceRoot: destination.workspaceRoot,
      origin: 'import',
      deferCommit: true,
    });
    const recordedByPath = new Map(result.recorded.map((saved) => [saved.artifactPath, saved]));
    const skippedInputs = new Set(result.skipped.map((skipped) => skipped.input));
    const members: ImportSetMemberV1[] = [];
    let importSet: ImportedPrimerRecordSummary['importSet'] = null;
    let importSetError: string | undefined;
    let importSetRelativePaths: string[] = [];
    try {
      for (const entry of entries) {
        const artifactPath = entry.primer.artifactPath;
        if (!artifactPath) continue;
        const recorded = recordedByPath.get(artifactPath);
        const artifact = recorded
          ? recorded.artifact
          : skippedInputs.has(entry.primer)
            ? (
                await primerServices.persistence.readArtifactAtPath(
                  artifactPath,
                  destination.workspaceRoot
                )
              ).artifact
            : null;
        if (!artifact) continue;
        members.push({
          sourceRecordId: entry.record.id,
          sourceRowId: entry.sourceRowId,
          ...(typeof entry.record.sourceRow === 'number'
            ? { sourceRow: entry.record.sourceRow }
            : {}),
          ...(entry.record.externalRowId ? { externalRowId: entry.record.externalRowId } : {}),
          entityId: artifact.id,
          entityKind: artifact.registry.kind,
          artifactRelativePath: artifact.file.workspaceRelativePath,
        });
      }
      if (members.length > 0 && destination.persistImportSet !== false) {
        const persisted = await persistImportedPrimerImportSet({
          partitions: [{ plan, members }],
          workspaceRoot: destination.workspaceRoot,
          destinationDir: destination.destinationDir,
          ...(destination.source ? { source: destination.source } : {}),
        });
        importSetRelativePaths = persisted.relativePaths;
        importSet = persisted.importSet;
      }
    } catch (error) {
      importSetError = error instanceof Error ? error.message : String(error);
    }

    const primerRels = result.recorded.map((saved) => saved.artifact.file.workspaceRelativePath);
    const partialPrimerRels = result.failed.flatMap((failed) => {
      const relative = failed.artifactPath
        ? pathRelativeToBoundary(failed.artifactPath, destination.workspaceRoot)
        : null;
      return relative ? [relative] : [];
    });
    const historyPaths = [...primerRels, ...importSetRelativePaths];
    if (historyPaths.length > 0) {
      await commitPrimerBatchHistory(
        destination.workspaceRoot,
        historyPaths,
        limsBefore,
        `Import ${result.recorded.length} primer${result.recorded.length === 1 ? '' : 's'}`
      );
    }

    const oligoRecords = plan.records.filter((r) =>
      isOligoImportKind(plan.importFamily ?? r.entityDraft.kind)
    );
    const acceptedCreate = oligoRecords.filter((r) => r.accepted && r.action === 'create').length;
    const rejected = oligoRecords.length - acceptedCreate;
    const acceptedWithoutSequence = acceptedCreate - primers.length;
    return {
      added: result.recorded.length,
      skipped: result.skipped.length + rejected + acceptedWithoutSequence,
      failed: result.failed.length,
      failures: result.failed.map((f) => ({ name: f.input.name, message: f.message })),
      artifactRelativePaths: [...primerRels, ...partialPrimerRels],
      importSet,
      ...(importSetError ? { importSetError } : {}),
      members,
      partition: { plan, members },
    };
  }
  return {
    oligoImportSourceRowId,
    plannedPrimersFromImport,
    plannedPrimersForDestination,
    persistImportedPrimerImportSet,
    recordImportedPrimers,
  };
}
