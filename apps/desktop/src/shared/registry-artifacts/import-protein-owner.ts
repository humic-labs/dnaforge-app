import type { createProteinArtifactOwner } from '../protein-artifacts/protein-artifact-owner';
import type { createEntityArtifactOwner } from './entity-artifact-owner';
import type { ArtifactHistoryPort } from '../artifact-operation-ports';
import {
  LIMS_GIT_EXPORT_RELATIVE_PATH,
  type LimsImportPlan,
  type LimsImportPlanRecord,
} from '../lims';
import { sha256Hex } from '../primer-artifacts/primer-artifact';
import { ProteinProjectionError } from '../protein-artifacts/protein-artifact-owner';

import type { EntityArtifactSourceV1 } from '../entity-artifact';
import type { LimsImportFileProvenance } from './ingress-core';
import type {
  PersistImportSetOperation,
  ImportSetMemberV1,
  ImportSetSourceInput,
} from './import-set-core';

import type { BeginWorkflowAction } from '../workflow-operation';
export interface ImportedProteinImportPartition {
  plan: LimsImportPlan;
  members: ImportSetMemberV1[];
}

export interface ImportedProteinRecordSummary {
  added: number;
  skipped: number;
  failed: number;
  failures: Array<{ name: string; message: string }>;
  reconciliationRequired: Array<{ name: string; message: string; artifactRelativePath: string }>;
  artifactRelativePaths: string[];
  artifactAbsolutePaths: string[];
  gitCommitted: boolean;
  importSet: { id: string; manifestRelativePath: string } | null;
  importSetError?: string;
  members: ImportSetMemberV1[];
  partition: ImportedProteinImportPartition;
}

export type ImportedProteinSourceInput = ImportSetSourceInput;

type ProteinRowOutcome =
  | {
      status: 'recorded';
      record: LimsImportPlanRecord;
      aminoAcids: string;
      saved: Awaited<ReturnType<ReturnType<typeof createProteinArtifactOwner>['recordProtein']>>;
    }
  | {
      status: 'reconciliation-required';
      record: LimsImportPlanRecord;
      aminoAcids: string;
      error: ProteinProjectionError;
    }
  | { status: 'skipped' }
  | { status: 'failed'; name: string; message: string };

type ImportedProteinDestination = {
  workspaceRoot: string;
  destinationDir: string;
  fileProvenance?: LimsImportFileProvenance;
  source?: ImportedProteinSourceInput;
  persistImportSet?: boolean;
};
export interface createProteinImportWriterDependencies {
  projectionError?: typeof ProteinProjectionError;
  recordProtein: ReturnType<typeof createProteinArtifactOwner>['recordProtein'];
  gitCommitPaths: ArtifactHistoryPort['gitCommitPaths'];
  isGitRepo: ArtifactHistoryPort['isGitRepo'];
  persistImportSet: PersistImportSetOperation;
  resolveEntityArtifactSchemaFields: ReturnType<
    typeof createEntityArtifactOwner
  >['resolveEntityArtifactSchemaFields'];
  beginWorkflowAction: BeginWorkflowAction;
}
export function createProteinImportWriter(dependencies: createProteinImportWriterDependencies) {
  const {
    recordProtein,
    gitCommitPaths,
    isGitRepo,
    persistImportSet,
    resolveEntityArtifactSchemaFields,
    beginWorkflowAction,
  } = dependencies;
  function acceptedProteinRecords(plan: LimsImportPlan): LimsImportPlanRecord[] {
    return plan.records.filter(
      (record) =>
        record.accepted &&
        record.action === 'create' &&
        (record.entityDraft.kind === 'protein' || plan.importFamily === 'protein') &&
        record.duplicateCandidates.length === 0 &&
        record.errors.length === 0
    );
  }

  function inlineAminoAcids(record: LimsImportPlanRecord): string | null {
    const sequence = record.entityDraft.fields.sequence as
      | { mode?: unknown; aminoAcids?: unknown }
      | undefined;
    return sequence?.mode === 'inline' && typeof sequence.aminoAcids === 'string'
      ? sequence.aminoAcids
      : null;
  }

  function importedProteinSource(
    plan: LimsImportPlan,
    record: LimsImportPlanRecord,
    fileProvenance?: LimsImportFileProvenance
  ): EntityArtifactSourceV1 {
    return {
      type: 'file_import',
      recordId: record.id,
      sourceName: plan.sourceName,
      sourceKind: plan.sourceKind,
      ...(typeof record.sourceRow === 'number' ? { sourceRow: record.sourceRow } : {}),
      values: { ...record.source, ...(fileProvenance ?? {}) },
    };
  }

  async function proteinSourceRowId(
    plan: LimsImportPlan,
    record: LimsImportPlanRecord,
    aminoAcids: string
  ): Promise<string> {
    if (record.externalRowId) return `external-${record.externalRowId}`;
    const identity = JSON.stringify({
      sourceName: plan.sourceName,
      sourcePartition: plan.selectedSheet,
      kind: 'protein',
      name: record.entityDraft.name,
      aminoAcids,
    });
    return `rowid-${(await sha256Hex(identity)).slice(0, 32)}`;
  }

  async function recordProteinRow(
    plan: LimsImportPlan,
    record: LimsImportPlanRecord,
    destination: {
      workspaceRoot: string;
      destinationDir: string;
      fileProvenance?: LimsImportFileProvenance;
    },
    resolvedSchemaFields: Awaited<
      ReturnType<ReturnType<typeof createEntityArtifactOwner>['resolveEntityArtifactSchemaFields']>
    >
  ): Promise<ProteinRowOutcome> {
    const aminoAcids = inlineAminoAcids(record);
    if (!aminoAcids) return { status: 'skipped' };
    const fields = record.entityDraft.fields;
    try {
      const saved = await recordProtein({
        entityKind: record.entityDraft.kind,
        entityFields: fields,
        name: record.entityDraft.name,
        sequence: aminoAcids,
        workspaceRoot: destination.workspaceRoot,
        dir: destination.destinationDir,
        sourceCds: typeof fields.sourceCds === 'string' ? fields.sourceCds : undefined,
        organism: typeof fields.organism === 'string' ? fields.organism : undefined,
        notes: typeof fields.notes === 'string' ? fields.notes : undefined,
        source: importedProteinSource(plan, record, destination.fileProvenance),
        registrationStatus: record.entityDraft.registrationStatus,
        domainStatus: record.entityDraft.domainStatus,
        deferCommit: true,
        resolvedSchemaFields,
      });
      return { status: 'recorded', record, aminoAcids, saved };
    } catch (error) {
      if (error instanceof (dependencies.projectionError ?? ProteinProjectionError)) {
        return { status: 'reconciliation-required', record, aminoAcids, error };
      }
      return {
        status: 'failed',
        name: record.entityDraft.name,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function recordImportedProteins(
    plan: LimsImportPlan,
    destination: ImportedProteinDestination
  ): Promise<ImportedProteinRecordSummary> {
    const selectedCount = acceptedProteinRecords(plan).length;
    if (selectedCount === 0) return recordProteinBatch(plan, destination);
    const operation = beginWorkflowAction({
      workflow: 'registry',
      action: 'create',
      workflowOrigin: 'direct',
    });
    try {
      const summary = await recordProteinBatch(plan, destination);
      const counts = {
        selectedCount,
        resultCount: summary.added,
        affectedCount: summary.members.length,
      };
      if (summary.members.length === 0 && summary.failures.length > 0) {
        operation.fail('record_failed', counts);
      } else if (summary.failures.length > 0 || summary.reconciliationRequired.length > 0) {
        operation.complete({ ...counts, status: 'needs_action' });
      } else {
        operation.complete({
          ...counts,
          status: summary.added > 0 ? 'created' : 'success',
          outcomeKind: summary.added > 0 ? 'record_created' : 'record_existing',
        });
      }
      return summary;
    } catch (error) {
      operation.fail('import_failed', { selectedCount });
      throw error;
    }
  }

  async function recordProteinBatch(
    plan: LimsImportPlan,
    destination: ImportedProteinDestination
  ): Promise<ImportedProteinRecordSummary> {
    const records = acceptedProteinRecords(plan);
    const members: ImportSetMemberV1[] = [];
    const artifactRelativePaths: string[] = [];
    const artifactAbsolutePaths: string[] = [];
    const failures: Array<{ name: string; message: string }> = [];
    const reconciliationRequired: ImportedProteinRecordSummary['reconciliationRequired'] = [];
    let added = 0;
    let skipped = plan.records.length - records.length;

    const outcomes: ProteinRowOutcome[] = [];
    if (records.length > 0) {
      const resolvedSchemaFields = await resolveEntityArtifactSchemaFields(
        records[0].entityDraft.kind
      );
      const concurrency = 4;
      for (let start = 0; start < records.length; start += concurrency) {
        outcomes.push(
          ...(await Promise.all(
            records
              .slice(start, start + concurrency)
              .map((record) => recordProteinRow(plan, record, destination, resolvedSchemaFields))
          ))
        );
      }
    }

    for (const outcome of outcomes) {
      if (outcome.status === 'skipped') {
        skipped += 1;
        continue;
      }
      if (outcome.status === 'failed') {
        failures.push({ name: outcome.name, message: outcome.message });
        continue;
      }
      const { record, aminoAcids } = outcome;
      if (outcome.status === 'recorded') {
        const { saved } = outcome;
        if (saved.created) added += 1;
        else skipped += 1;
        artifactRelativePaths.push(saved.artifactPath);
        artifactAbsolutePaths.push(saved.artifactAbsolutePath);
        members.push({
          sourceRecordId: record.id,
          sourceRowId: await proteinSourceRowId(plan, record, aminoAcids),
          ...(typeof record.sourceRow === 'number' ? { sourceRow: record.sourceRow } : {}),
          ...(record.externalRowId ? { externalRowId: record.externalRowId } : {}),
          entityId: saved.artifact.id,
          entityKind: saved.artifact.kind,
          artifactRelativePath: saved.artifactPath,
        });
        continue;
      }
      const { error } = outcome;
      if (error.created) added += 1;
      else skipped += 1;
      artifactRelativePaths.push(error.artifactPath);
      artifactAbsolutePaths.push(error.artifactAbsolutePath);
      members.push({
        sourceRecordId: record.id,
        sourceRowId: await proteinSourceRowId(plan, record, aminoAcids),
        ...(typeof record.sourceRow === 'number' ? { sourceRow: record.sourceRow } : {}),
        ...(record.externalRowId ? { externalRowId: record.externalRowId } : {}),
        entityId: error.artifact.id,
        entityKind: error.artifact.kind,
        artifactRelativePath: error.artifactPath,
      });
      reconciliationRequired.push({
        name: record.entityDraft.name,
        message: error.message,
        artifactRelativePath: error.artifactPath,
      });
    }

    let importSet: ImportedProteinRecordSummary['importSet'] = null;
    let importSetError: string | undefined;
    let importSetPaths: string[] = [];
    if (members.length > 0 && failures.length === 0 && destination.persistImportSet !== false) {
      try {
        const persisted = await persistImportSet({
          partitions: [{ plan, members }],
          workspaceRoot: destination.workspaceRoot,
          destinationDir: destination.destinationDir,
          ...(destination.source ? { source: destination.source } : {}),
        });
        importSet = persisted.importSet;
        importSetPaths = persisted.relativePaths;
      } catch (error) {
        importSetError = error instanceof Error ? error.message : String(error);
      }
    }

    let gitCommitted = false;
    try {
      const changedPaths = [
        ...artifactRelativePaths,
        ...importSetPaths,
        LIMS_GIT_EXPORT_RELATIVE_PATH,
      ];
      if (changedPaths.length > 0 && (await isGitRepo(destination.workspaceRoot))) {
        await gitCommitPaths(
          destination.workspaceRoot,
          `Import ${added} protein${added === 1 ? '' : 's'}`,
          changedPaths
        );
        gitCommitted = true;
      }
    } catch (error) {
      console.warn('[protein-import] Saved and registered, but Git history commit failed:', error);
    }

    return {
      added,
      skipped,
      failed: failures.length,
      failures,
      reconciliationRequired,
      artifactRelativePaths,
      artifactAbsolutePaths,
      gitCommitted,
      importSet,
      ...(importSetError ? { importSetError } : {}),
      members,
      partition: { plan, members },
    };
  }
  return { recordImportedProteins };
}
