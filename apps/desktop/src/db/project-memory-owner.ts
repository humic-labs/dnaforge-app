import { isAbsolutePathLike, pathRelativeToBoundary } from '../shared/path-boundary';

const PROJECT_MEMORY_SCHEMA = {
  manifest: 'waypoint.project-memory.manifest.v1',
  entity: 'waypoint.project-memory.entity.v1',
  file: 'waypoint.project-memory.file.v1',
  link: 'waypoint.project-memory.link.v1',
  event: 'waypoint.project-memory.event.v1',
} as const;
export type ProjectMemoryEntityKind =
  | 'file'
  | 'folder'
  | 'notebook'
  | 'design'
  | 'sequence'
  | 'primer'
  | 'selection'
  | 'structure'
  | 'result'
  | 'workflow_run';
export type ProjectMemoryEntityStatus = 'active' | 'missing' | 'archived' | 'conflict';
export type ProjectMemoryFileStatus = 'current' | 'historical' | 'missing' | 'conflict';
export type ProjectMemoryLinkConfidence = 'confirmed' | 'suggested' | 'rejected';
export type ProjectMemoryFileKind =
  | ProjectMemoryEntityKind
  | 'genbank'
  | 'fasta'
  | 'fastq'
  | 'waypoint-notebook'
  | 'waypoint-design'
  | 'waypoint-sequence'
  | 'waypoint-plasmid';
export type ProjectMemoryEventType =
  | 'project_initialized'
  | 'artifact_created'
  | 'artifact_renamed'
  | 'artifact_moved'
  | 'artifact_updated'
  | 'file_tracked'
  | 'file_binding_repaired'
  | 'file_marked_missing'
  | 'conflict_detected'
  | 'relationship_confirmed'
  | 'relationship_rejected'
  | 'design_graduated_to_sequence'
  | 'agent_proposal_accepted';
export interface ProjectMemoryManifest {
  schema: typeof PROJECT_MEMORY_SCHEMA.manifest;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
}
export interface ProjectMemoryEntity {
  schema: typeof PROJECT_MEMORY_SCHEMA.entity;
  id: string;
  kind: ProjectMemoryEntityKind;
  displayName: string;
  status: ProjectMemoryEntityStatus;
  createdByEventId: string;
  updatedByEventId: string;
}
export interface ProjectMemoryFile {
  schema: typeof PROJECT_MEMORY_SCHEMA.file;
  entityId: string;
  path: string;
  fileKind: ProjectMemoryFileKind;
  status: ProjectMemoryFileStatus;
  contentHash?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  createdByEventId: string;
  updatedByEventId: string;
}
export interface ProjectMemoryLink {
  schema: typeof PROJECT_MEMORY_SCHEMA.link;
  sourceEntityId: string;
  relation: 'created_in' | 'created_beside' | 'produces' | 'derived_from';
  targetEntityId: string;
  confidence: ProjectMemoryLinkConfidence;
  evidence: Record<string, unknown>;
  createdByEventId: string;
  updatedByEventId: string;
}
export interface ProjectMemoryEvent {
  schema: typeof PROJECT_MEMORY_SCHEMA.event;
  eventId: string;
  operationId: string;
  idempotencyKey: string;
  eventType: ProjectMemoryEventType;
  actor: {
    kind: 'user' | 'agent' | 'system';
    id?: string;
    approvedBy?: string;
  };
  createdAt: string;
  entityIds: string[];
  paths: Array<{
    before?: string;
    after?: string;
    current?: string;
  }>;
  payload: Record<string, unknown>;
}
export interface ProjectMemoryReplayResult {
  entities: ProjectMemoryEntity[];
  files: ProjectMemoryFile[];
  links: ProjectMemoryLink[];
  conflicts: string[];
}
export interface ProjectMemorySnapshot extends ProjectMemoryReplayResult {
  manifest: ProjectMemoryManifest | null;
  events: ProjectMemoryEvent[];
}
function nowIso(): string {
  return new Date().toISOString();
}
function stableId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function projectMemoryDir(workspaceRoot: string): string {
  return `${stripTrailingSlash(workspaceRoot)}/.waypoint/project-memory`;
}
function projectMemoryPaths(workspaceRoot: string) {
  const dir = projectMemoryDir(workspaceRoot);
  return {
    dir,
    waypointDir: `${stripTrailingSlash(workspaceRoot)}/.waypoint`,
    manifest: `${dir}/manifest.json`,
    events: `${dir}/events.jsonl`,
    entities: `${dir}/entities.jsonl`,
    files: `${dir}/files.jsonl`,
    links: `${dir}/links.jsonl`,
  };
}
function stripTrailingSlash(path: string): string {
  return path.endsWith('/') && path !== '/' ? path.replace(/\/+$/, '') : path;
}
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
function assertProjectMemoryPath(path: string, label: string): void {
  if (path.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (isAbsolutePathLike(path) || /^[A-Za-z]:/.test(path) || path.startsWith('~')) {
    throw new Error(`${label} must be workspace-relative: ${path}`);
  }
  if (path.includes('\\') || path.includes('\0')) {
    throw new Error(`${label} must be a POSIX workspace-relative path: ${path}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must not contain empty, current, or parent segments: ${path}`);
  }
}
export function workspaceRelativeProjectMemoryPath(input: {
  workspaceRoot: string;
  path: string;
}): string {
  const path = stripTrailingSlash(input.path);
  const windowsRoot = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(input.workspaceRoot);
  const relative = isAbsolutePathLike(path)
    ? pathRelativeToBoundary(path, input.workspaceRoot, {
        platform: windowsRoot ? 'win32' : 'posix',
      })
    : path;
  if (relative === null || (!windowsRoot && path.includes('\\'))) {
    throw new Error(`project memory path must be a POSIX workspace-relative path: ${path}`);
  }
  assertProjectMemoryPath(relative, 'project memory path');
  return relative;
}
function serializeJsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
function createManifest(existing: ProjectMemoryManifest | null): ProjectMemoryManifest {
  const timestamp = nowIso();
  return {
    schema: PROJECT_MEMORY_SCHEMA.manifest,
    projectId: existing?.projectId || stableId('project'),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    appVersion: existing?.appVersion || 'dev',
  };
}
function validatePathReferences(event: ProjectMemoryEvent): void {
  for (const pathRef of event.paths) {
    if (pathRef.before) assertProjectMemoryPath(pathRef.before, 'event path before');
    if (pathRef.after) assertProjectMemoryPath(pathRef.after, 'event path after');
    if (pathRef.current) assertProjectMemoryPath(pathRef.current, 'event path current');
  }
}
export function validateProjectMemoryEvent(value: unknown): ProjectMemoryEvent {
  const event = objectValue(value);
  if (!event || event.schema !== PROJECT_MEMORY_SCHEMA.event) {
    throw new Error('Invalid project memory event schema');
  }
  const actor = objectValue(event.actor);
  const payload = objectValue(event.payload);
  const parsed: ProjectMemoryEvent = {
    schema: PROJECT_MEMORY_SCHEMA.event,
    eventId: requireString(event.eventId, 'eventId'),
    operationId: requireString(event.operationId, 'operationId'),
    idempotencyKey: requireString(event.idempotencyKey, 'idempotencyKey'),
    eventType: requireString(event.eventType, 'eventType') as ProjectMemoryEventType,
    actor: {
      kind: (actor?.kind === 'agent' || actor?.kind === 'system' ? actor.kind : 'user') as
        | 'user'
        | 'agent'
        | 'system',
      ...(stringValue(actor?.id) ? { id: stringValue(actor?.id)! } : {}),
      ...(stringValue(actor?.approvedBy) ? { approvedBy: stringValue(actor?.approvedBy)! } : {}),
    },
    createdAt: requireString(event.createdAt, 'createdAt'),
    entityIds: arrayValue<string>(event.entityIds).map((id) => requireString(id, 'entityId')),
    paths: arrayValue<ProjectMemoryEvent['paths'][number]>(event.paths).map((pathRef) => ({
      ...(stringValue(pathRef.before) ? { before: stringValue(pathRef.before)! } : {}),
      ...(stringValue(pathRef.after) ? { after: stringValue(pathRef.after)! } : {}),
      ...(stringValue(pathRef.current) ? { current: stringValue(pathRef.current)! } : {}),
    })),
    payload: payload ?? {},
  };
  validatePathReferences(parsed);
  return parsed;
}
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Project memory ${field} must be a non-empty string`);
  }
  return value;
}
function sameEvent(a: ProjectMemoryEvent, b: ProjectMemoryEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function entityFromPayload(event: ProjectMemoryEvent): {
  id: string;
  kind: ProjectMemoryEntityKind;
  displayName: string;
} | null {
  const entity = objectValue(event.payload.entity);
  if (!entity) return null;
  return {
    id: requireString(entity.id, 'payload.entity.id'),
    kind: requireString(entity.kind, 'payload.entity.kind') as ProjectMemoryEntityKind,
    displayName: requireString(entity.displayName, 'payload.entity.displayName'),
  };
}
function fileFromPayload(event: ProjectMemoryEvent): {
  entityId: string;
  path: string;
  fileKind: ProjectMemoryFileKind;
  sizeBytes?: number;
} | null {
  const file = objectValue(event.payload.file);
  if (!file) return null;
  const path = requireString(file.path, 'payload.file.path');
  assertProjectMemoryPath(path, 'payload.file.path');
  return {
    entityId: requireString(file.entityId, 'payload.file.entityId'),
    path,
    fileKind: requireString(file.fileKind, 'payload.file.fileKind') as ProjectMemoryFileKind,
    sizeBytes: numberValue(file.sizeBytes),
  };
}
export function replayProjectMemoryEvents(
  rawEvents: ProjectMemoryEvent[]
): ProjectMemoryReplayResult {
  const events = rawEvents.map(validateProjectMemoryEvent);
  const seenIdempotency = new Map<string, ProjectMemoryEvent>();
  const entities = new Map<string, ProjectMemoryEntity>();
  const files = new Map<string, ProjectMemoryFile>();
  const links = new Map<string, ProjectMemoryLink>();
  const conflicts: string[] = [];
  function markEntityConflict(entityId: string, eventId: string): void {
    const existing = entities.get(entityId);
    if (existing) {
      entities.set(entityId, {
        ...existing,
        status: 'conflict',
        updatedByEventId: eventId,
      });
    }
  }
  for (const event of events) {
    const existing = seenIdempotency.get(event.idempotencyKey);
    if (existing) {
      if (!sameEvent(existing, event)) {
        conflicts.push(`Conflicting idempotency key: ${event.idempotencyKey}`);
      }
      continue;
    }
    seenIdempotency.set(event.idempotencyKey, event);
    if (
      event.eventType === 'artifact_created' ||
      event.eventType === 'file_tracked' ||
      event.eventType === 'design_graduated_to_sequence'
    ) {
      const entity = entityFromPayload(event);
      const file = fileFromPayload(event);
      if (!entity || !file) {
        conflicts.push(`Missing entity or file payload for ${event.eventId}`);
        continue;
      }
      const existingEntity = entities.get(entity.id);
      if (existingEntity && existingEntity.kind !== entity.kind) {
        conflicts.push(`Entity ${entity.id} changed kind`);
        markEntityConflict(entity.id, event.eventId);
      } else {
        entities.set(entity.id, {
          schema: PROJECT_MEMORY_SCHEMA.entity,
          id: entity.id,
          kind: entity.kind,
          displayName: entity.displayName,
          status: existingEntity?.status ?? 'active',
          createdByEventId: existingEntity?.createdByEventId ?? event.eventId,
          updatedByEventId: event.eventId,
        });
      }
      const currentFilesForEntity = Array.from(files.values()).filter(
        (candidate) => candidate.entityId === file.entityId && candidate.status === 'current'
      );
      if (
        currentFilesForEntity.length > 0 &&
        currentFilesForEntity.every((candidate) => candidate.path !== file.path)
      ) {
        conflicts.push(`Entity ${file.entityId} has multiple current file bindings`);
        markEntityConflict(file.entityId, event.eventId);
        for (const candidate of currentFilesForEntity) {
          files.set(`${candidate.entityId}:${candidate.path}`, {
            ...candidate,
            status: 'conflict',
            updatedByEventId: event.eventId,
          });
        }
      }
      const hasCurrentBindingConflict =
        currentFilesForEntity.length > 0 &&
        currentFilesForEntity.every((candidate) => candidate.path !== file.path);
      files.set(`${file.entityId}:${file.path}`, {
        schema: PROJECT_MEMORY_SCHEMA.file,
        entityId: file.entityId,
        path: file.path,
        fileKind: file.fileKind,
        status: hasCurrentBindingConflict ? 'conflict' : 'current',
        ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
        createdByEventId:
          files.get(`${file.entityId}:${file.path}`)?.createdByEventId ?? event.eventId,
        updatedByEventId: event.eventId,
      });
      if (event.eventType !== 'design_graduated_to_sequence') continue;
    }
    if (
      event.eventType === 'artifact_renamed' ||
      event.eventType === 'artifact_moved' ||
      event.eventType === 'file_binding_repaired'
    ) {
      const entityId = event.entityIds[0];
      const pathRef = event.paths[0];
      if (!entityId || !pathRef?.before || !pathRef.after) {
        conflicts.push(`Missing move payload for ${event.eventId}`);
        continue;
      }
      const previousKey = `${entityId}:${pathRef.before}`;
      const previous = files.get(previousKey);
      if (previous) {
        files.set(previousKey, {
          ...previous,
          status: 'historical',
          updatedByEventId: event.eventId,
        });
      }
      files.set(`${entityId}:${pathRef.after}`, {
        schema: PROJECT_MEMORY_SCHEMA.file,
        entityId,
        path: pathRef.after,
        fileKind: previous?.fileKind ?? 'file',
        status: 'current',
        createdByEventId: previous?.createdByEventId ?? event.eventId,
        updatedByEventId: event.eventId,
      });
    }
    if (
      event.eventType === 'relationship_confirmed' ||
      event.eventType === 'design_graduated_to_sequence'
    ) {
      const linkPayload = objectValue(event.payload.link);
      if (!linkPayload) continue;
      const link: ProjectMemoryLink = {
        schema: PROJECT_MEMORY_SCHEMA.link,
        sourceEntityId: requireString(linkPayload.sourceEntityId, 'payload.link.sourceEntityId'),
        relation: requireString(
          linkPayload.relation,
          'payload.link.relation'
        ) as ProjectMemoryLink['relation'],
        targetEntityId: requireString(linkPayload.targetEntityId, 'payload.link.targetEntityId'),
        confidence: 'confirmed',
        evidence: objectValue(linkPayload.evidence) ?? {},
        createdByEventId: event.eventId,
        updatedByEventId: event.eventId,
      };
      links.set(`${link.sourceEntityId}:${link.relation}:${link.targetEntityId}`, link);
    }
  }
  return {
    entities: Array.from(entities.values()).sort((a, b) => a.id.localeCompare(b.id)),
    files: Array.from(files.values()).sort((a, b) =>
      `${a.entityId}:${a.path}`.localeCompare(`${b.entityId}:${b.path}`)
    ),
    links: Array.from(links.values()).sort((a, b) =>
      `${a.sourceEntityId}:${a.relation}:${a.targetEntityId}`.localeCompare(
        `${b.sourceEntityId}:${b.relation}:${b.targetEntityId}`
      )
    ),
    conflicts,
  };
}
export function createArtifactCreatedProjectMemoryEvent(input: {
  workspaceRoot: string;
  entityId: string;
  entityKind: Extract<ProjectMemoryEntityKind, 'notebook' | 'design' | 'selection' | 'structure'>;
  displayName: string;
  filePath: string;
  fileKind: Extract<ProjectMemoryEntityKind, 'notebook' | 'design' | 'selection' | 'structure'>;
  sizeBytes?: number;
  artifactSchema: string;
  operationId?: string;
}): ProjectMemoryEvent {
  const path = workspaceRelativeProjectMemoryPath({
    workspaceRoot: input.workspaceRoot,
    path: input.filePath,
  });
  const operationId = input.operationId ?? stableId('op');
  return {
    schema: PROJECT_MEMORY_SCHEMA.event,
    eventId: stableId('evt'),
    operationId,
    idempotencyKey: `artifact_created:${input.entityId}:${path}`,
    eventType: 'artifact_created',
    actor: { kind: 'user' },
    createdAt: nowIso(),
    entityIds: [input.entityId],
    paths: [{ current: path }],
    payload: {
      artifactSchema: input.artifactSchema,
      entity: {
        id: input.entityId,
        kind: input.entityKind,
        displayName: input.displayName,
      },
      file: {
        entityId: input.entityId,
        path,
        fileKind: input.fileKind,
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      },
    },
  };
}
export function createArtifactRenamedProjectMemoryEvent(input: {
  workspaceRoot: string;
  entityId: string;
  oldPath: string;
  newPath: string;
  artifactSchema: string;
  operationId?: string;
}): ProjectMemoryEvent {
  const before = workspaceRelativeProjectMemoryPath({
    workspaceRoot: input.workspaceRoot,
    path: input.oldPath,
  });
  const after = workspaceRelativeProjectMemoryPath({
    workspaceRoot: input.workspaceRoot,
    path: input.newPath,
  });
  const operationId = input.operationId ?? stableId('op');
  return {
    schema: PROJECT_MEMORY_SCHEMA.event,
    eventId: stableId('evt'),
    operationId,
    idempotencyKey: `artifact_renamed:${input.entityId}:${before}:${after}`,
    eventType: 'artifact_renamed',
    actor: { kind: 'user' },
    createdAt: nowIso(),
    entityIds: [input.entityId],
    paths: [{ before, after }],
    payload: {
      artifactSchema: input.artifactSchema,
    },
  };
}
export function createFileBindingRepairedProjectMemoryEvent(input: {
  workspaceRoot: string;
  entityId: string;
  oldPath: string;
  newPath: string;
  artifactSchema: string;
  operationId?: string;
}): ProjectMemoryEvent {
  const before = workspaceRelativeProjectMemoryPath({
    workspaceRoot: input.workspaceRoot,
    path: input.oldPath,
  });
  const after = workspaceRelativeProjectMemoryPath({
    workspaceRoot: input.workspaceRoot,
    path: input.newPath,
  });
  const operationId = input.operationId ?? stableId('op');
  return {
    schema: PROJECT_MEMORY_SCHEMA.event,
    eventId: stableId('evt'),
    operationId,
    idempotencyKey: `file_binding_repaired:${input.entityId}:${before}:${after}`,
    eventType: 'file_binding_repaired',
    actor: { kind: 'user' },
    createdAt: nowIso(),
    entityIds: [input.entityId],
    paths: [{ before, after }],
    payload: {
      artifactSchema: input.artifactSchema,
    },
  };
}
export function createDesignGraduatedToSequenceProjectMemoryEvent(input: {
  workspaceRoot: string;
  designId: string;
  designDisplayName: string;
  designFilePath: string;
  sequenceEntityId: string;
  sequenceDisplayName: string;
  sequenceBindingPath: string;
  sequenceLength: number;
  circular: boolean;
  sizeBytes?: number;
  operationId?: string;
}): ProjectMemoryEvent {
  const designPath = workspaceRelativeProjectMemoryPath({
    workspaceRoot: input.workspaceRoot,
    path: input.designFilePath,
  });
  const sequencePath = workspaceRelativeProjectMemoryPath({
    workspaceRoot: input.workspaceRoot,
    path: input.sequenceBindingPath,
  });
  const operationId = input.operationId ?? stableId('op');
  return {
    schema: PROJECT_MEMORY_SCHEMA.event,
    eventId: stableId('evt'),
    operationId,
    idempotencyKey: `design_graduated_to_sequence:${input.designId}:${input.sequenceEntityId}`,
    eventType: 'design_graduated_to_sequence',
    actor: { kind: 'user' },
    createdAt: nowIso(),
    entityIds: [input.designId, input.sequenceEntityId],
    paths: [{ current: designPath }],
    payload: {
      artifactSchema: 'waypoint.design.v1',
      sourceEntity: {
        id: input.designId,
        kind: 'design',
        displayName: input.designDisplayName,
      },
      entity: {
        id: input.sequenceEntityId,
        kind: 'sequence',
        displayName: input.sequenceDisplayName,
      },
      file: {
        entityId: input.sequenceEntityId,
        path: sequencePath,
        fileKind: 'genbank',
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      },
      link: {
        sourceEntityId: input.designId,
        relation: 'produces',
        targetEntityId: input.sequenceEntityId,
        evidence: {
          source: 'design-graduation',
          sequenceLength: input.sequenceLength,
          circular: input.circular,
          format: 'genbank',
        },
      },
      sequence: {
        length: input.sequenceLength,
        circular: input.circular,
        format: 'genbank',
      },
    },
  };
}
export interface ProjectMemoryFiles {
  mkdir(
    path: string,
    options?: {
      recursive?: boolean;
    },
    mutationToken?: string
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(
    path: string,
    content: string,
    options?: {
      append?: boolean;
    },
    mutationToken?: string
  ): Promise<void>;
}
export interface AppendProjectMemoryEventInput {
  workspaceRoot: string;
  event: ProjectMemoryEvent;
  mutationToken?: string;
}

const projectMemoryMutations = new Map<string, Promise<unknown>>();

async function runProjectMemoryMutation<T>(
  workspaceRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = stripTrailingSlash(workspaceRoot);
  const previous = projectMemoryMutations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  projectMemoryMutations.set(key, current);
  try {
    return await current;
  } finally {
    if (projectMemoryMutations.get(key) === current) projectMemoryMutations.delete(key);
  }
}

export function createProjectMemoryOwner(files: () => ProjectMemoryFiles) {
  async function ensureProjectMemoryDirectory(
    workspaceRoot: string,
    mutationToken?: string
  ): Promise<void> {
    const paths = projectMemoryPaths(workspaceRoot);
    await files().mkdir(paths.waypointDir, { recursive: true }, mutationToken);
    await files().mkdir(paths.dir, { recursive: true }, mutationToken);
  }
  async function readTextIfExists(path: string): Promise<string | null> {
    if (!(await files().exists(path))) return null;
    return files().readTextFile(path);
  }
  async function readJsonl<T>(path: string, validator: (value: unknown) => T): Promise<T[]> {
    const content = await readTextIfExists(path);
    if (!content) return [];
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => validator(JSON.parse(line)));
  }
  async function readManifest(workspaceRoot: string): Promise<ProjectMemoryManifest | null> {
    const content = await readTextIfExists(projectMemoryPaths(workspaceRoot).manifest);
    if (!content) return null;
    const parsed = objectValue(JSON.parse(content));
    if (!parsed || parsed.schema !== PROJECT_MEMORY_SCHEMA.manifest) {
      throw new Error('Invalid project memory manifest');
    }
    return {
      schema: PROJECT_MEMORY_SCHEMA.manifest,
      projectId: stringValue(parsed.projectId) ?? '',
      createdAt: stringValue(parsed.createdAt) ?? '',
      updatedAt: stringValue(parsed.updatedAt) ?? '',
      appVersion: stringValue(parsed.appVersion) ?? 'unknown',
    };
  }
  async function writeMaterializedState(input: {
    workspaceRoot: string;
    manifest: ProjectMemoryManifest;
    events: ProjectMemoryEvent[];
    replay: ProjectMemoryReplayResult;
    mutationToken?: string;
  }): Promise<void> {
    const paths = projectMemoryPaths(input.workspaceRoot);
    await files().writeTextFile(
      paths.manifest,
      `${JSON.stringify(input.manifest, null, 2)}\n`,
      undefined,
      input.mutationToken
    );
    await files().writeTextFile(
      paths.events,
      serializeJsonl(input.events),
      undefined,
      input.mutationToken
    );
    await files().writeTextFile(
      paths.entities,
      serializeJsonl(input.replay.entities),
      undefined,
      input.mutationToken
    );
    await files().writeTextFile(
      paths.files,
      serializeJsonl(input.replay.files),
      undefined,
      input.mutationToken
    );
    await files().writeTextFile(
      paths.links,
      serializeJsonl(input.replay.links),
      undefined,
      input.mutationToken
    );
  }
  async function readProjectMemory(workspaceRoot: string): Promise<ProjectMemorySnapshot> {
    const paths = projectMemoryPaths(workspaceRoot);
    const manifest = await readManifest(workspaceRoot);
    const events = await readJsonl(paths.events, validateProjectMemoryEvent);
    return {
      manifest,
      events,
      ...replayProjectMemoryEvents(events),
    };
  }
  async function appendProjectMemoryEvent(input: {
    workspaceRoot: string | null | undefined;
    event: ProjectMemoryEvent;
    mutationToken?: string;
  }): Promise<ProjectMemorySnapshot | null> {
    const workspaceRoot = input.workspaceRoot;
    if (!workspaceRoot) return null;
    return runProjectMemoryMutation(workspaceRoot, () =>
      appendUnlocked({ ...input, workspaceRoot })
    );
  }
  async function appendUnlocked(
    input: AppendProjectMemoryEventInput
  ): Promise<ProjectMemorySnapshot> {
    await ensureProjectMemoryDirectory(input.workspaceRoot, input.mutationToken);
    const existingManifest = await readManifest(input.workspaceRoot);
    const paths = projectMemoryPaths(input.workspaceRoot);
    const existingEvents = await readJsonl(paths.events, validateProjectMemoryEvent);
    const event = validateProjectMemoryEvent(input.event);
    const duplicate = existingEvents.find(
      (existing) => existing.idempotencyKey === event.idempotencyKey
    );
    let events = existingEvents;
    if (duplicate) {
      if (!sameEvent(duplicate, event)) {
        throw new Error(`Project memory idempotency conflict: ${event.idempotencyKey}`);
      }
    } else {
      events = [...existingEvents, event];
    }
    const manifest = createManifest(existingManifest);
    const replay = replayProjectMemoryEvents(events);
    await writeMaterializedState({
      workspaceRoot: input.workspaceRoot,
      manifest,
      events,
      replay,
      mutationToken: input.mutationToken,
    });
    return {
      manifest,
      events,
      ...replay,
    };
  }
  return { readProjectMemory, appendProjectMemoryEvent };
}
