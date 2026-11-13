import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { platform } from '../../../platform';
import {
  listImportableSheets,
  type LimsEntityKind,
  type LimsImportPlan,
} from '../../../shared/lims';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { DryRunLimsImportInput } from '../../lims/public/ingress';
import { prepareLimsImportReview } from '../../lims/public/import-review-client';
import {
  recordImportedPrimers,
  type ImportedPrimerRecordSummary,
} from '../../lims/public/import-primer-bridge';
import {
  recordImportedProteins,
  type ImportedProteinRecordSummary,
} from '../../lims/public/import-protein-bridge';
import { getUserFolders, resolveMultiRootPath, resolveWorkspacePath } from './path-utils';

const columnMappingSchema = z
  .object({
    sourceColumn: z.string().min(1).max(500),
    mappedField: z.string().min(1).max(500).optional(),
    mappingMode: z.enum(['mapped', 'source_only', 'ignored']).optional(),
  })
  .strict();

export const importEntitiesSchema = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .max(2000)
      .describe('Project-relative CSV, TSV, Excel, or FASTA source path.'),
    entityType: z.enum(['dna_oligo', 'rna_oligo', 'protein']),
    destinationPath: z
      .string()
      .min(1)
      .max(2000)
      .default('imports')
      .describe('Destination folder relative to the source project.'),
    sheetName: z.string().min(1).max(500).optional(),
    columnMappings: z.array(columnMappingSchema).max(200).optional(),
  })
  .strict();

interface LoadedImportSource {
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export interface ImportEntitiesDependencies {
  readSource(path: string): Promise<LoadedImportSource>;
  createPlan(input: DryRunLimsImportInput): Promise<LimsImportPlan>;
  ensureDestination(path: string): Promise<void>;
  recordProteins(
    plan: LimsImportPlan,
    destination: Parameters<typeof recordImportedProteins>[1]
  ): Promise<ImportedProteinRecordSummary>;
  recordOligos(
    plan: LimsImportPlan,
    destination: Parameters<typeof recordImportedPrimers>[1]
  ): Promise<ImportedPrimerRecordSummary>;
}

async function readImportSource(path: string): Promise<LoadedImportSource> {
  if (/\.(xlsx|xls|xlsm)$/i.test(path)) {
    const bytes = await platform().fs.readFile(path);
    return { arrayBuffer: bytes.slice().buffer as ArrayBuffer };
  }
  return { text: await platform().fs.readTextFile(path) };
}

const defaultDependencies: ImportEntitiesDependencies = {
  readSource: readImportSource,
  createPlan: prepareLimsImportReview,
  ensureDestination: (path) => platform().fs.mkdir(path, { recursive: true }),
  recordProteins: recordImportedProteins,
  recordOligos: recordImportedPrimers,
};

function forcedKind(
  entityType: z.infer<typeof importEntitiesSchema>['entityType']
): LimsEntityKind {
  return entityType === 'dna_oligo' ? 'oligo' : entityType;
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'import.csv';
}

type AgentImportPlanDisposition = 'write' | 'unchanged' | 'review';

function classifyAgentImportPlan(plan: LimsImportPlan): AgentImportPlanDisposition {
  if (plan.records.length === 0) return 'review';
  let creates = 0;
  for (const record of plan.records) {
    const blockingLink = record.unresolvedLinks.some((link) => link.severity === 'blocking');
    const cleanDuplicate =
      record.duplicateCandidates.length > 0 &&
      record.errors.length === 0 &&
      !record.requiresRegistrationKind &&
      !blockingLink;
    if (cleanDuplicate) continue;
    const cleanCreate =
      record.accepted &&
      record.action === 'create' &&
      record.errors.length === 0 &&
      record.duplicateCandidates.length === 0 &&
      !record.requiresRegistrationKind &&
      !blockingLink;
    if (!cleanCreate) return 'review';
    creates += 1;
  }
  return creates > 0 ? 'write' : 'unchanged';
}

function reviewRequiredResult(plan: LimsImportPlan, message: string) {
  return {
    ...toolFailure({ code: 'IMPORT_REVIEW_REQUIRED', error: message, retriable: false,
      stateChanged: false, partialEffects: [], details: { aggregateWarnings: plan.aggregateWarnings,
        sheetDispositions: plan.sheetDispositions, records: plan.records.slice(0, 50).map(record => ({
          id: record.id, name: record.entityDraft.name, accepted: record.accepted,
          errors: record.errors, warnings: record.warnings,
        })) } }),
    changed: false, message,
    aggregateWarnings: plan.aggregateWarnings,
    sheetDispositions: plan.sheetDispositions,
    records: plan.records.slice(0, 50).map((record) => ({
      id: record.id,
      name: record.entityDraft.name,
      accepted: record.accepted,
      errors: record.errors,
      warnings: record.warnings,
    })),
  };
}

   
                                                                              
                                                                               
                                                                              
   
export function createImportEntitiesTool(
  folders: WorkspaceFolder[],
  dependencies: ImportEntitiesDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Import DNA oligos, RNA oligos, or proteins from a project CSV, TSV, Excel, or FASTA file. ' +
      'The tool creates and validates the same typed import plan as the human wizard, refuses when ' +
      'mapping review is still required, and writes the same file-authoritative packages and ' +
      'import-set provenance. It never drives the UI or writes Registry as authority.',
    inputSchema: importEntitiesSchema,
    execute: async (input: z.infer<typeof importEntitiesSchema>) => {
      let writeAttempted = false;
      try {
        const userFolders = getUserFolders(folders);
        if (userFolders.length === 0) {
          throw new Error('No writable project is open.');
        }
        const source = resolveMultiRootPath(folders, input.sourcePath);
        if (source.folder.pinned) {
          throw new Error('Pinned development resources are read-only and cannot own imports.');
        }
        const destinationDir = resolveWorkspacePath(
          source.folder.path,
          input.destinationPath ?? 'imports'
        );
        const loaded = await dependencies.readSource(source.absolutePath);
        const plan = await dependencies.createPlan({
          fileName: fileName(source.absolutePath),
          sourcePath: source.absolutePath,
          forcedKind: forcedKind(input.entityType),
          ...(loaded.text !== undefined ? { text: loaded.text } : {}),
          ...(loaded.arrayBuffer ? { arrayBuffer: loaded.arrayBuffer } : {}),
          ...(input.sheetName ? { sheetName: input.sheetName } : {}),
          ...(input.columnMappings ? { columnMappings: input.columnMappings } : {}),
        });
        const importableSheets = listImportableSheets(plan.sheetDispositions);
        if (input.sheetName && plan.selectedSheet !== input.sheetName) {
          return reviewRequiredResult(
            plan,
            `Worksheet "${input.sheetName}" was not found. Choose an exact worksheet name.`
          );
        }
        if (!input.sheetName && importableSheets.length > 1) {
          return reviewRequiredResult(
            plan,
            'This workbook contains multiple importable worksheets. Choose one explicitly.'
          );
        }
        const disposition = classifyAgentImportPlan(plan);
        if (disposition === 'review') {
          return reviewRequiredResult(
            plan,
            'The import plan needs explicit mapping or record review before it can apply.'
          );
        }
        if (disposition === 'unchanged') {
          return toolSuccess({
            changed: false,
            code: 'IMPORT_UNCHANGED' as const,
            message: 'Every source record already exists; no packages were written.',
            imported: 0,
            skipped: plan.records.length,
            failed: 0,
            artifactPaths: [],
            importSet: null,
          });
        }
        const destination = {
          workspaceRoot: source.folder.path,
          destinationDir,
          source: { sourcePath: source.absolutePath },
        };
        writeAttempted = true;
        await dependencies.ensureDestination(destinationDir);
        const summary =
          input.entityType === 'protein'
            ? await dependencies.recordProteins(plan, destination)
            : await dependencies.recordOligos(plan, destination);
        const receipt = {
          changed: summary.added > 0,
          entityType: input.entityType,
          imported: summary.added,
          skipped: summary.skipped,
          failed: summary.failed,
          failures: summary.failures,
          artifactPaths: summary.artifactRelativePaths,
          importSet: summary.importSet,
          ...(summary.importSetError ? { importSetError: summary.importSetError } : {}),
        };
        if (summary.failed > 0 || summary.importSetError) {
          return { ...receipt, ...toolFailure({code: 'ENTITY_IMPORT_PARTIAL_FAILURE',
            error: 'The import did not complete. Inspect the recorded partial effects before retrying.',
            retriable: false, stateChanged: summary.added > 0 ? true : 'unknown',
            partialEffects: summary.artifactRelativePaths.map(path => ({artifactPath: path})),
            details: receipt,
          }) };
        }
        return toolSuccess(receipt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {changed: false, message, ...toolFailure({code: 'ENTITY_IMPORT_FAILED', error: message,
          retriable: false, stateChanged: writeAttempted ? 'unknown' : false, partialEffects: []})};
      }
    },
  });
}

const importCounts = {
  changed: z.boolean(), imported: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), artifactPaths: z.array(z.string()),
  importSet: z.object({id: z.string(), manifestRelativePath: z.string()}).nullable(),
};
export const importEntitiesOutputSchema = z.union([
  z.object({ok: z.literal(true), ...importCounts, code: z.literal('IMPORT_UNCHANGED'), message: z.string()}),
  z.object({ok: z.literal(true), ...importCounts, entityType: z.enum(['dna_oligo', 'rna_oligo', 'protein']),
    failures: z.array(z.object({name: z.string(), message: z.string()})), importSetError: z.string().optional()}),
]);
