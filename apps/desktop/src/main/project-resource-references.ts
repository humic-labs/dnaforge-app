import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { decodeInlineReferenceUrl } from '../shared/inline-reference-codec';
import { nativeEntityReferenceIdFromHref } from '../shared/native-entity-reference';
import {
  projectResourceReferenceFromHref,
  projectResourceReferenceHref,
  projectResourceReferenceSchema,
  type ProjectResourceReference,
  type ResolvedProjectResourceReference,
} from '../shared/project-resource-reference';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { catalogIconContext } from '../shared/catalog-icon-context';
import {
  createRegisteredProjectAuthority,
  type RegisteredProjectAuthority,
} from './registered-project-authority';

interface CatalogResource {
  entityId: string;
  name: string;
  type: string;
  path: string;
  workspaceId: number;
  metadata?: string | null;
}

export function createProjectResourceReferences(options: {
  db(): Database.Database;
  registeredProjects?: RegisteredProjectAuthority;
}) {
  const projects = options.registeredProjects ?? createRegisteredProjectAuthority(options);
  const byEntity = (entityId: string): CatalogResource[] =>
    options
      .db()
      .prepare(
        "SELECT e.id AS entityId,e.name,e.type,e.metadata,f.path,e.workspace_id AS workspaceId FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id AND f.workspace_id=e.workspace_id WHERE e.id=? AND e.status='active' AND f.status='current'"
      )
      .all(entityId) as CatalogResource[];
  const resolve = async (
    input: string | ProjectResourceReference
  ): Promise<ResolvedProjectResourceReference> => {
    let reference: ProjectResourceReference | null =
      typeof input === 'string'
        ? projectResourceReferenceFromHref(input)
        : projectResourceReferenceSchema.parse(input);
    let legacyPath: { projectId: string; path: string } | null = null;
    if (!reference && typeof input === 'string') {
      const entityId = nativeEntityReferenceIdFromHref(input);
      if (entityId) {
        const matches = byEntity(entityId).filter((row) =>
          projects.list().some((project) => project.id === row.workspaceId)
        );
        if (matches.length !== 1)
          throw new Error('The reference has no unique registered project owner.');
        const project = projects.list().find((project) => project.id === matches[0].workspaceId)!;
        reference = { kind: 'entity', projectId: project.projectId, entityId };
      } else {
        const decoded = decodeInlineReferenceUrl(input);
        if (!decoded.ok || !['workspace-path', 'path-entity'].includes(decoded.declaration.kind))
          throw new Error('This internal reference is not a supported project resource.');
        const declaration = decoded.declaration;
        if (declaration.kind !== 'workspace-path' && declaration.kind !== 'path-entity')
          throw new Error('This internal reference has no project resource target.');
        const project = projects.resolve(declaration.root);
        if (!project) throw new Error('The reference project is missing or ambiguous.');
        legacyPath = { projectId: project.projectId, path: declaration.segments.join('/') };
      }
    }
    const projectId = reference?.projectId ?? legacyPath!.projectId;
    const project = projects.resolve(projectId);
    if (!project || project.projectId !== projectId)
      throw new Error('The reference project is unavailable.');
    const assertCurrent = projects.capture(project.projectId, false);
    const rows = reference?.kind === 'entity' ? byEntity(reference.entityId) : [];
    if (reference?.kind === 'entity' && (rows.length !== 1 || rows[0].workspaceId !== project.id))
      throw new Error('The resource identity does not belong to its referenced project.');
    const relativePath = reference?.kind === 'path' ? reference.path : legacyPath?.path;
    if (relativePath !== undefined)
      projectResourceReferenceSchema.parse({
        kind: 'path',
        projectId,
        path: relativePath,
        resourceKind: 'file',
      });
    const candidate = rows[0]?.path ?? join(project.path, relativePath!);
    const physical = await canonicalWorkspacePath({
      workspaceRoot: project.path,
      path: candidate,
      allowMissing: false,
      artifactNoun: 'project resource',
    });
    const status = await stat(physical.candidate);
    if (!status.isFile() && !status.isDirectory())
      throw new Error('The referenced project resource is not a file or directory.');
    const resourceKind = status.isDirectory() ? 'directory' : 'file';
    if (reference?.kind === 'path' && reference.resourceKind !== resourceKind)
      throw new Error('The referenced resource kind changed.');
    const bindings = rows.length
      ? rows
      : (options
          .db()
          .prepare(
            "SELECT e.id AS entityId,e.name,e.type,e.metadata,f.path,e.workspace_id AS workspaceId FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id AND f.workspace_id=e.workspace_id WHERE f.path=? AND f.workspace_id=? AND e.status='active' AND f.status='current'"
          )
          .all(physical.candidate, project.id) as CatalogResource[]);
    if (bindings.length > 1)
      throw new Error('The referenced resource has ambiguous catalog ownership.');
    const binding = bindings[0];
    const target: ProjectResourceReference = binding
      ? { kind: 'entity', projectId, entityId: binding.entityId }
      : { kind: 'path', projectId, path: relativePath!, resourceKind };
    projectResourceReferenceHref(target);
    assertCurrent();
    return {
      reference: target,
      workspaceRoot: project.path,
      path: physical.candidate,
      entityType: binding?.type ?? resourceKind,
      iconContext: catalogIconContext({
        kind: binding?.type ?? resourceKind,
        path: physical.candidate,
        metadata: binding?.metadata,
      }),
      label: binding?.name ?? basename(physical.candidate),
    };
  };
  return { resolve };
}
