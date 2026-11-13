import { withUserMessage } from '@waypoint/user-messages';
import type { ArtifactRegistryOperations } from '../artifact-operation-ports';
import type { createEntityArtifactOwner } from '../registry-artifacts/entity-artifact-owner';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../path-boundary';
import type { LimsEntity, LimsFieldDefinition } from '../lims';
import {
  buildInlineProteinSequenceRef,
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '../registry-artifacts/protein-sequence-value';
import { EntityArtifactCreationProjectionError } from '../registry-artifacts/entity-artifact-owner';

import { ENTITY_ARTIFACT_SUFFIX, sanitizeEntityArtifactStem } from '../entity-artifact';
import type {
  EntityArtifactRelationshipV1,
  EntityArtifactSourceV1,
  EntityArtifact,
} from '../entity-artifact';
import { sha256Hex } from '../primer-artifacts/primer-artifact';
export class ProteinProjectionError extends Error {
  readonly code = 'PROTEIN_REGISTRY_RECONCILIATION_REQUIRED';

  constructor(
    public readonly artifactPath: string,
    public readonly artifactAbsolutePath: string,
    public readonly artifact: EntityArtifact,
    public readonly created: boolean,
    cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Protein package saved to ${artifactPath}, but Registry projection failed. ` +
        `The package is safe and can be reconciled. ${detail}`
    );
    this.name = 'ProteinProjectionError';
    withUserMessage(this, 'protein.registrationPending');
  }
}

export interface RecordProteinInput {
  entityKind?: string;
  id?: string;
  artifactStem?: string;
  entityFields?: Record<string, unknown>;
  name: string;
  sequence: string;
  workspaceRoot: string;

  dir?: string;
  sourceCds?: string;
  organism?: string;
  notes?: string;

  workspaceId?: number;
  actor?: string | null;
  source?: EntityArtifactSourceV1;
  relationships?: EntityArtifactRelationshipV1[];
  registrationStatus?: EntityArtifact['registrationStatus'];
  domainStatus?: string | null;
  deferCommit?: boolean;
  resolvedSchemaFields?: readonly LimsFieldDefinition[];
}

export interface ProteinArtifactPathValidation {
  valid: boolean;
  relativePath?: string;
  error?: string;
}

export interface RecordedProteinArtifact {
  artifactPath: string;
  artifactAbsolutePath: string;
  artifact: EntityArtifact;
  limsEntity: LimsEntity;
  gitCommitted: boolean;
  created: boolean;
}

export class ProteinArtifactPathError extends Error {
  readonly code = 'PROTEIN_ARTIFACT_PATH_OUTSIDE_WORKSPACE';

  constructor(message: string) {
    super(message);
    this.name = 'ProteinArtifactPathError';
    withUserMessage(this, 'protein.destinationOutsideProject');
  }
}
export interface createProteinArtifactOwnerDependencies {
  recordEntityArtifact: ReturnType<typeof createEntityArtifactOwner>['recordEntityArtifact'];
  queryLimsEntities: ArtifactRegistryOperations['queryLimsEntities'];
}
export function createProteinArtifactOwner(dependencies: createProteinArtifactOwnerDependencies) {
  const { recordEntityArtifact, queryLimsEntities } = dependencies;
  function validateProteinArtifactPath(
    artifactAbsolutePath: string,
    workspaceRoot: string
  ): ProteinArtifactPathValidation {
    const relativePath = pathRelativeToBoundary(artifactAbsolutePath, workspaceRoot);
    if (
      relativePath == null ||
      relativePath.length === 0 ||
      !isSafeWorkspaceRelativePath(relativePath)
    ) {
      return { valid: false, error: 'Protein packages must be saved inside the owning workspace.' };
    }
    return { valid: true, relativePath };
  }

  function sanitizeProteinFileStem(name: string): string {
    return sanitizeEntityArtifactStem(name) || 'Protein';
  }

  function joinPath(left: string, right: string): string {
    const separator = left.includes('\\') ? '\\' : '/';
    return `${left.replace(/[\\/]+$/, '')}${separator}${right.replace(/^[\\/]+/, '')}`;
  }

  async function proteinArtifactIdentity(
    input: Pick<RecordProteinInput, 'name' | 'sequence' | 'id' | 'artifactStem' | 'entityKind'>
  ): Promise<{ id: string; artifactStem: string; aminoAcids: string }> {
    if (input.id !== undefined && (!input.id || input.id.trim() !== input.id))
      throw new Error('A supplied protein identity must be nonempty and unchanged by trimming.');
    if (input.artifactStem !== undefined && !input.artifactStem.trim())
      throw new Error('A supplied protein file name must be nonempty.');
    const name = input.name.trim();
    if (!name) throw new Error('Protein name is required.');
    const aminoAcids = normalizeProteinSequence(input.sequence);
    const validationError = proteinSequenceValidationError(aminoAcids);
    if (validationError) throw new Error(validationError);
    const sequenceHash = await sha256Hex(aminoAcids);
    const identityHash = await sha256Hex(
      JSON.stringify({ kind: input.entityKind ?? 'protein', name, aminoAcids })
    );
    return {
      id: input.id ?? `protein-${identityHash.slice(0, 32)}`,
      artifactStem:
        input.artifactStem === undefined
          ? `${sanitizeProteinFileStem(name)}-${sequenceHash.slice(0, 8)}`
          : sanitizeProteinFileStem(input.artifactStem),
      aminoAcids,
    };
  }

  function proteinDestinationDir(workspaceRoot: string, dir?: string): string {
    return dir ?? joinPath(workspaceRoot, 'proteins');
  }

  async function recordProtein(input: RecordProteinInput): Promise<RecordedProteinArtifact> {
    const identity = await proteinArtifactIdentity(input);
    const destinationDir = proteinDestinationDir(input.workspaceRoot, input.dir);
    const previewPath = joinPath(
      destinationDir,
      `${identity.artifactStem}${ENTITY_ARTIFACT_SUFFIX}`
    );
    const validation = validateProteinArtifactPath(previewPath, input.workspaceRoot);
    if (!validation.valid) {
      throw new ProteinArtifactPathError(validation.error ?? 'Invalid destination folder.');
    }

    let recorded: Awaited<
      ReturnType<ReturnType<typeof createEntityArtifactOwner>['recordEntityArtifact']>
    >;
    try {
      recorded = await recordEntityArtifact({
        id: identity.id,
        artifactStem: identity.artifactStem,
        kind: input.entityKind ?? 'protein',
        name: input.name,
        fields: {
          ...input.entityFields,
          sequence: await buildInlineProteinSequenceRef(identity.aminoAcids),
          sourceCds: input.sourceCds ?? input.entityFields?.sourceCds,
          organism: input.organism ?? input.entityFields?.organism,
          notes: input.notes ?? input.entityFields?.notes,
        },
        workspaceRoot: input.workspaceRoot,
        destinationDir,
        source: input.source,
        relationships: input.relationships,
        registrationStatus: input.registrationStatus,
        domainStatus: input.domainStatus,
        deferCommit: input.deferCommit,
        resolvedSchemaFields: input.resolvedSchemaFields,
      });
    } catch (error) {
      if (error instanceof EntityArtifactCreationProjectionError) {
        throw new ProteinProjectionError(
          error.relativePath,
          error.artifactPath,
          error.artifact,
          error.created,
          error
        );
      }
      throw error;
    }

    const [limsEntity] = await queryLimsEntities({ id: recorded.artifact.id, limit: 1 });
    if (!limsEntity) {
      throw new ProteinProjectionError(
        recorded.relativePath,
        recorded.artifactPath,
        recorded.artifact,
        recorded.created,
        new Error('The Registry projection could not be read after reconciliation.')
      );
    }
    return {
      artifactPath: recorded.relativePath,
      artifactAbsolutePath: recorded.artifactPath,
      artifact: recorded.artifact,
      limsEntity,
      gitCommitted: recorded.gitCommitted,
      created: recorded.created,
    };
  }

  async function previewProteinArtifactPath(
    workspaceRoot: string,
    name: string,
    sequence: string,
    dir?: string
  ): Promise<string> {
    const identity = await proteinArtifactIdentity({ name, sequence });
    const absolutePath = joinPath(
      proteinDestinationDir(workspaceRoot, dir),
      `${identity.artifactStem}${ENTITY_ARTIFACT_SUFFIX}`
    );
    const validation = validateProteinArtifactPath(absolutePath, workspaceRoot);
    if (!validation.valid) {
      throw new ProteinArtifactPathError(validation.error ?? 'Invalid destination folder.');
    }
    return validation.relativePath!;
  }
  return {
    validateProteinArtifactPath,
    sanitizeProteinFileStem,
    recordProtein,
    previewProteinArtifactPath,
  };
}
