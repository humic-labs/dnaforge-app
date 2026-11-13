export { registryRecordsOutputSchema } from './lims-output-schemas';
import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  getLimsSchemas,
  getLimsRegistryPreview,
  replaceLimsRecordRelationships,
  getLimsEntityHistory,
  updateLimsEntity,
  archiveLimsEntity,
  restoreLimsEntity,
  revertLimsEntity,
} from '../../lims/public/operations';
import { getLimsEntityById } from '../../lims/public/open-target';
import {
  recordEntityArtifact,
  EntityArtifactCreationProjectionError,
} from '../../lims/public/record-entity-artifact';
import { getWorkspaceRootById } from '../../../db/workspace-catalog';
import { LIMS_REGISTRATION_STATUSES } from '../../../shared/lims';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveExplicitProjectRoot,
  soleWritableProjectRoot,
  writableProjectRoots,
} from '../../../shared/project-root-selection';
import { projectPublicSequenceValue } from './public-sequence-projection';
import { useWorkspaceStore } from '../../../stores/workspaceStore';

const target = {
  entityId: z.string().min(1),
  expectedEventSeq: z.number().int().min(0),
  operationId: z.string().uuid(),
};
const page = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
};
export const registryRecordsSchema = z
  .object({
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('schemas'), entityKind: z.string().optional(), ...page }).strict(),
      z.object({ kind: z.literal('inspect'), entityId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('history'), entityId: z.string().min(1), ...page }).strict(),
      z
        .object({
          kind: z.literal('create'),
          entityId: z.string().uuid().describe('New UUID, retained for retries.'),
          entityKind: z.string().min(1),
          name: z.string().trim().min(1).max(500),
          fields: z.record(z.unknown()),
          destinationProject: z.string().optional(),
          registrationStatus: z.enum(LIMS_REGISTRATION_STATUSES).optional(),
          domainStatus: z.string().nullable().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('update'),
          ...target,
          name: z.string().trim().min(1).max(500).optional(),
          fields: z.record(z.unknown()).optional(),
          relationshipTargets: z.record(z.string().nullable()).optional(),
          registrationStatus: z.enum(LIMS_REGISTRATION_STATUSES).optional(),
          domainStatus: z.string().nullable().optional(),
        })
        .strict(),
      z.object({ kind: z.literal('archive'), ...target }).strict(),
      z.object({ kind: z.literal('restore'), ...target }).strict(),
      z.object({ kind: z.literal('undo'), ...target }).strict(),
      z
        .object({
          kind: z.literal('relationships'),
          ...target,
          relationships: z.array(
            z
              .object({
                toEntityId: z.string().min(1),
                type: z.string().min(1),
                payload: z.record(z.unknown()).optional(),
              })
              .strict()
          ),
        })
        .strict(),
    ]),
  })
  .strict();

export function createRegistryRecordsTool(folders: readonly WorkspaceFolder[]) {
  return resultTool({
    description:
      'Create, inspect, update, archive, restore or undo schema-backed Registry records using native audited commands and portable record files. Discover current field definitions with schemas. Registry reads are global. File-backed edits must belong to a mounted writable project. Inspect returns eventSeq; every edit needs that expectedEventSeq and a stable UUID operationId. Inspect also returns the complete outgoing relationships. The relationships operation replaces that complete list: preserve existing links and payloads when adding a link; an empty list clears it. Use native type identifiers such as derives_from or variant_of and exact active portable record IDs in the same project. Biological sequence content uses sequence_document.',
    inputSchema: registryRecordsSchema,
    execute: async ({ operation }) => {
      let attempted = false;
      const fail = (code: string, error: string) =>
        toolFailure({
          code,
          error,
          retriable: false,
          stateChanged: attempted ? 'unknown' : false,
          partialEffects: [],
        });
      try {
        if (operation.kind === 'schemas') {
          const schemas = (await getLimsSchemas()).filter(
            (schema) => !operation.entityKind || schema.entityKind === operation.entityKind
          );
          return toolSuccess({
            schemas: schemas.slice(operation.offset, operation.offset + operation.limit),
            total: schemas.length,
            nextOffset:
              operation.offset + operation.limit < schemas.length
                ? operation.offset + operation.limit
                : null,
          });
        }
        if (operation.kind === 'create') {
          const roots = writableProjectRoots(folders);
          const project = operation.destinationProject
            ? resolveExplicitProjectRoot(roots, operation.destinationProject)
            : soleWritableProjectRoot(roots);
          if (!project)
            return fail(
              'PROJECT_REQUIRED',
              'Choose an exact mounted writable project from get_workspace.'
            );
          attempted = true;
          const saved = await recordEntityArtifact({
            id: operation.entityId,
            artifactStem: operation.entityId,
            kind: operation.entityKind,
            name: operation.name,
            fields: operation.fields,
            workspaceRoot: project.path,
            destinationDir: project.path,
            registrationStatus: operation.registrationStatus,
            domainStatus: operation.domainStatus,
          });
          useWorkspaceStore.getState().bumpFileTreeRefresh();
          const entity = await getLimsEntityById(saved.artifact.id);
          if (!entity)
            return fail(
              'RECORD_PROJECTION_MISSING',
              'The record file exists but its Registry projection is missing.'
            );
          return toolSuccess({
            entity: projectPublicSequenceValue(entity),
            created: saved.created,
            saved: true,
            relativePath: saved.relativePath,
            historyCommitted: saved.gitCommitted,
          });
        }
        const entity = await getLimsEntityById(operation.entityId);
        if (!entity)
          return fail('RECORD_NOT_FOUND', 'Use Registry discovery for the exact entity ID.');
        if (operation.kind === 'inspect') {
          const preview = await getLimsRegistryPreview({ entityId: entity.id });
          return toolSuccess({
            entity: projectPublicSequenceValue(entity),
            relationships: preview.outgoingLinks.map(({ link }) => ({
              toEntityId: link.toEntityId,
              type: link.type,
              payload: link.payload,
            })),
          });
        }
        if (operation.kind === 'history') {
          const history = await getLimsEntityHistory({ entityId: entity.id });
          return toolSuccess({
            entityId: entity.id,
            history: history.slice(operation.offset, operation.offset + operation.limit),
            total: history.length,
            nextOffset:
              operation.offset + operation.limit < history.length
                ? operation.offset + operation.limit
                : null,
          });
        }



        if (entity.workspaceId !== null) {
          const owner = await getWorkspaceRootById(entity.workspaceId);
          if (!owner || !writableProjectRoots(folders).some((folder) => folder.path === owner))
            return fail(
              'RECORD_OWNER_NOT_WRITABLE',
              'Mount the owning project with write access before editing this record.'
            );
        }
        const input = {
          id: entity.id,
          expectedEventSeq: operation.expectedEventSeq,
          operationId: operation.operationId,
          actor: 'agent',
        };
        attempted = true;
        let result;
        if (operation.kind === 'relationships') {
          const relationships = await replaceLimsRecordRelationships({
            entityId: entity.id,
            relationships: operation.relationships,
            expectedEventSeq: operation.expectedEventSeq,
            operationId: operation.operationId,
            actor: 'agent',
          });
          useWorkspaceStore.getState().bumpFileTreeRefresh();
          return toolSuccess({ ...relationships });
        } else if (operation.kind === 'update') {
          const {
            kind: _,
            entityId: __,
            expectedEventSeq: ___,
            operationId: ____,
            ...changes
          } = operation;
          result = {
            entity: await updateLimsEntity({ ...input, ...changes }, { initiator: 'system' }),
          };
        } else if (operation.kind === 'archive')
          result = { entity: await archiveLimsEntity(input, { initiator: 'system' }) };
        else if (operation.kind === 'restore')
          result = { entity: await restoreLimsEntity(input, { initiator: 'system' }) };
        else result = await revertLimsEntity(input);
        useWorkspaceStore.getState().bumpFileTreeRefresh();
        return toolSuccess({ ...result, entity: projectPublicSequenceValue(result.entity) });
      } catch (error) {
        if (
          error instanceof Error &&
          /Record changed|STALE_RECORD|Registry record changed; refresh it before saving\./.test(
            error.message
          )
        )
          return toolFailure({
            code: 'STALE_RECORD',
            error: 'The record changed. Inspect it again before editing.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          });
        if (error instanceof EntityArtifactCreationProjectionError)
          return toolFailure({
            code: 'RECORD_PROJECTION_FAILED',
            error: error.message,
            retriable: false,
            stateChanged: true,
            partialEffects: [
              { entityId: error.artifact.id, relativePath: error.relativePath, saved: true },
            ],
          });
        return fail(
          'REGISTRY_OPERATION_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
}
