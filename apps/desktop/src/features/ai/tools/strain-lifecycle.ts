import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { readScientificNamespace } from '../../../services/read-scientific-namespace';
import {
  EntityArtifactAcceptedSavePendingError,
  EntityArtifactCreationProjectionError,
  recordEntityArtifact,
} from '../../lims/public/record-entity-artifact';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { getUserFolders, resolveWorkspacePath } from './path-utils';

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const relationshipSchema = z
  .object({
    type: z.enum(['derives_from', 'has_genome', 'carried_by']),
    targetEntityId: identity.describe('Existing parent strain or sequence identity, never a path.'),
    targetRevisionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exact accepted target revision. Omit only to pin the target accepted at creation time.'
      ),
    metadata: z
      .record(z.unknown())
      .default({})
      .superRefine((value, context) => {
        if (Object.hasOwn(value, 'assertion') || Object.hasOwn(value, 'targetRevisionId'))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Assertion and revision are explicit relationship fields.',
          });
        if (value.confidence === 'WGS_verified' || value.confidence === 'partially_verified')
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A planned relationship cannot claim physical verification.',
          });
      }),
  })
  .strict();

export const createStrainSchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe('Project name; required when multiple projects are open.'),
    strainId: identity
      .optional()
      .describe('Stable identity for an unchanged retry; otherwise allocated by the writer.'),
    name: z.string().min(1).max(200),
    directory: z
      .string()
      .min(1)
      .default('strains')
      .describe('Project-relative destination directory.'),
    fields: z
      .record(z.unknown())
      .describe(
        'Registry fields. genotypeCanonical is required; species, markers, growthConditions and notes are supported. These describe intended designs, not measured results.'
      ),
    relationships: z
      .array(relationshipSchema)
      .default([])
      .describe(
        'Planned links owned by the new strain: derives_from points to its parent; has_genome to an exact chromosome/allele; carried_by identifies a plasmid carried by the strain. Save the exact intended sequences first.'
      ),
  })
  .strict();

export const listScientificObjectsSchema = z
  .object({
    workspace: z.string().min(1).optional(),
  })
  .strict();

function project(folders: WorkspaceFolder[], requested?: string): string {
  const roots = getUserFolders(folders);
  const selected = requested
    ? resolveExplicitProjectRoot(roots, requested)
    : roots.length === 1
      ? roots[0]
      : null;
  if (!selected)
    throw new Error(
      requested
        ? `Project not found or ambiguous: ${requested}`
        : roots.length === 0
          ? 'No project is open.'
          : 'Multiple projects are open; provide the project name.'
    );
  return selected.path;
}

export function createListScientificObjectsTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'List accepted scientific-object identities, paths and exact revision pins in one project. This reads accepted database state, including closed objects, without sequence bases or working-file contents. An unenrolled legacy project returns enrolled:false.',
    inputSchema: listScientificObjectsSchema,
    execute: async (input: z.infer<typeof listScientificObjectsSchema>) => {
      try {
        const namespace = await readScientificNamespace(project(folders, input.workspace));
        return toolSuccess({
          enrolled: namespace !== null,
          workspaceVersionId: namespace?.head ?? null,
          objects: namespace?.entries.filter((entry) => !entry.tombstone) ?? [],
        });
      } catch (error) {
        return toolFailure({
          code: 'SCIENTIFIC_OBJECT_LIST_FAILED',
          error: String(error),
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}

export function createCreateStrainTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Save one PLANNED strain through the same native record writer as the Add/Create strain form, including genotype, selection fields, ancestry and exact sequence links. Enrolled projects accept immutable database history before native delivery, Registry refresh and Git history. The result is an intended construction, never proof of a physical strain. Reuse returned strainId for an unchanged pending-publication retry.',
    inputSchema: createStrainSchema,
    execute: async (input: z.infer<typeof createStrainSchema>) => {
      const strainId = input.strainId ?? crypto.randomUUID();
      let writerStarted = false;
      try {
        const workspaceRoot = project(folders, input.workspace);
        const destinationDir = resolveWorkspacePath(workspaceRoot, input.directory);
        const relationships = input.relationships.map((link) => ({
          type: link.type,
          fromEntityId: link.type === 'carried_by' ? link.targetEntityId : strainId,
          toEntityId: link.type === 'carried_by' ? strainId : link.targetEntityId,
          payload: {
            ...link.metadata,
            assertion: 'planned',
            ...(link.targetRevisionId ? { targetRevisionId: link.targetRevisionId } : {}),
          },
        }));
        writerStarted = true;
        const saved = await recordEntityArtifact({
          id: strainId,
          kind: 'strain',
          name: input.name,
          fields: input.fields,
          workspaceRoot,
          destinationDir,
          relationships,
          domainStatus: 'planned',
        });
        return toolSuccess({
          strainId: saved.artifact.id,
          name: saved.artifact.name,
          artifactPath: saved.relativePath,
          planned: true,
          created: saved.created,
          gitCommitted: saved.gitCommitted,
          acceptedRevision: saved.acceptedRevision ?? null,
          relationships: saved.artifact.relationships,
        });
      } catch (error) {
        const pending =
          error instanceof EntityArtifactAcceptedSavePendingError ||
          error instanceof EntityArtifactCreationProjectionError;
        return toolFailure({
          code: pending ? 'STRAIN_PUBLICATION_PENDING' : 'STRAIN_CREATE_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: pending,
          stateChanged: pending ? true : writerStarted ? 'unknown' : false,
          partialEffects: pending
            ? [
                {
                  strainId,
                  artifactPath: error.artifactPath,
                  ...(error instanceof EntityArtifactAcceptedSavePendingError
                    ? { acceptedRevision: error.acceptedRevision }
                    : {}),
                },
              ]
            : [],
          details: { strainId, retryInput: { ...input, strainId } },
        });
      }
    },
  });
}
