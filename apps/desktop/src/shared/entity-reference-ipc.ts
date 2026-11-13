import type { ChatEntityReferenceIpcRow } from './entity-reference-types';

import { canonicalJson } from './canonical-json';
import { isAbsolutePathLike } from './path-boundary';
import { molecularReferenceSnapshotIndex, resolveMolecularReference } from './molecular-reference';

export type { ChatEntityReferenceIpcRow } from './entity-reference-types';

export const AUTHORED_ENTITY_REFERENCE_KINDS = [
  'sequence',
  'sequence_region',
  'annotation',
  'primer',
  'notebook',
  'alignment',
  'structure',
  'molecular-document',
  'assembly',
  'protein',
  'record',
  'file',
  'folder',
  'protein-prediction',
  'variant-analysis',
  'structure-inspection',
  'protein_visual_benchmark_run',
  'protein_visual_prompt_trial',
  'protein_visual_prompt_result',
  'external',
] as const;

export function classifyAuthoredEntityReference(
  row: ChatEntityReferenceIpcRow
):
  | 'catalog'
  | 'registry'
  | 'molecular'
  | 'filesystem'
  | 'external'
  | 'compute-result'
  | 'inspection-continuation'
  | 'developer-result' {
  if (!(AUTHORED_ENTITY_REFERENCE_KINDS as readonly string[]).includes(row.entity_type))
    throw new Error('Unsupported authored entity reference type.');
  const route = /^entity:\/\/([^/]+)\/(.+)$/u.exec(row.locator);
  const data = referenceJsonObject(row.data);
  if (row.entity_type === 'primer') {
    if (route?.[1] !== 'primer')
      throw new Error('A primer reference must use its canonical primer route.');
    return 'registry';
  }
  if (row.locator.startsWith('git://')) {
    if (
      ![
        'sequence',
        'sequence_region',
        'annotation',
        'notebook',
        'alignment',
        'structure',
        'assembly',
        'protein',
        'record',
        'file',
        'folder',
      ].includes(row.entity_type)
    )
      throw new Error('Unsupported historical filesystem reference type.');
    return 'filesystem';
  }
  if (/^https?:\/\//u.test(row.locator)) {
    if (
      route ||
      [
        'protein-prediction',
        'variant-analysis',
        'structure-inspection',
        'protein_visual_benchmark_run',
        'protein_visual_prompt_trial',
        'protein_visual_prompt_result',
      ].includes(row.entity_type) ||
      [
        'documentId',
        'registryEntityId',
        'primerId',
        'targetDocumentId',
        'molecularViewTarget',
      ].some((key) => data?.[key] !== undefined)
    )
      throw new Error('An external reference cannot claim native entity identity.');
    return 'external';
  }
  const computeKind =
    row.entity_type === 'protein-prediction'
      ? 'protein-prediction-result'
      : row.entity_type === 'variant-analysis'
        ? 'sequence-variant-analysis'
        : null;
  if (computeKind) {
    if (route?.[1] !== row.entity_type || data?.kind !== computeKind || data.version !== 1)
      throw new Error('The inline compute reference route disagrees with its retained result.');
    return 'compute-result';
  }
  if (row.entity_type === 'structure-inspection') {
    if (
      route?.[1] !== 'structure' ||
      !route[2].startsWith('inspection-continuation:') ||
      data?.kind !== 'protein-inspection-continuation' ||
      data.version !== 1 ||
      typeof data.documentId !== 'string'
    )
      throw new Error('The inspection reference requires its explicit retained continuation.');
    return 'inspection-continuation';
  }
  const developerRoute: Record<string, string> = {
    protein_visual_benchmark_run: 'protein-visual-benchmark',
    protein_visual_prompt_trial: 'protein-prompt-trial',
    protein_visual_prompt_result: 'protein-prompt-result',
  };
  if (developerRoute[row.entity_type]) {
    if (
      !row.locator.startsWith(`dnaforge-dev://${developerRoute[row.entity_type]}/`) ||
      data?.kind !== row.entity_type ||
      data.version !== 1
    )
      throw new Error('The developer result reference route disagrees with its retained result.');
    return 'developer-result';
  }
  if (row.entity_type === 'molecular-document') {
    const molecular = resolveMolecularReference(row, { allowLegacyThinView: false });
    if (
      molecular?.kind !== 'document' ||
      !row.workspace_root_path ||
      row.workspace_scope !== molecular.document.projectId
    )
      throw new Error('The molecular document reference requires its exact owning project.');
    return 'molecular';
  }
  if (row.entity_type === 'structure') {
    if (route?.[1] !== 'structure' && route?.[1] !== 'molecular-view-target')
      throw new Error('The molecular reference type disagrees with its route.');
    resolveMolecularReference(row, { allowLegacyThinView: false });
    return 'molecular';
  }
  const catalogRoutes: Record<string, readonly string[]> = {
    sequence: ['sequence'],
    sequence_region: ['sequence', 'sequence_region'],
    annotation: ['sequence', 'annotation'],
    notebook: ['page', 'notebook'],
    assembly: ['assembly', 'design', 'construct'],
    alignment: ['alignment'],
    protein: ['protein'],
    record: ['record', 'lims'],
    file: ['file', 'workspace'],
    folder: ['folder', 'workspace'],
  };
  if (route && !catalogRoutes[row.entity_type]?.includes(route[1]))
    throw new Error('The entity reference type disagrees with its canonical route.');
  if (
    !route &&
    (!['sequence', 'sequence_region', 'annotation'].includes(row.entity_type) ||
      /[\\/]/u.test(row.locator) ||
      !row.locator)
  )
    throw new Error('Unsupported authored entity reference route.');
  return route?.[1] === 'protein' || route?.[1] === 'lims' ? 'registry' : 'catalog';
}

export interface CreateEntityReferenceParams {
  entityType: string;
  displayLabel: string;
  locator: string;
  deepLinkParams: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
  source: string;
  workspaceScope: string | null;
  workspaceRootPath: string | null;
}

export interface EntityReferenceUpdates {
  displayLabel?: string;
  locator?: string;
  deepLinkParams?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  status?: string;
}

export interface EntityReferenceRevisionInput {
  referenceId: string;
  changedBy: string;
  changeType: string;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
}

export interface EntityReferenceRevisionRow {
  id: string;
  reference_id: string;
  revision_number: number;
  changed_by: string;
  change_type: string;
  previous_state: string | null;
  new_state: string | null;
  created_at: number;
}

export function referenceJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  const decoded: unknown = JSON.parse(value);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new Error('Entity reference data must be an object or null.');
  return decoded as Record<string, unknown>;
}

export function validatePreparedEntityReferenceRow(row: ChatEntityReferenceIpcRow): void {
  if (
    !row ||
    ['id', 'entity_type', 'locator', 'source', 'status'].some(
      (key) =>
        typeof row[key as keyof ChatEntityReferenceIpcRow] !== 'string' ||
        !row[key as keyof ChatEntityReferenceIpcRow]
    ) ||
    typeof row.display_label !== 'string'
  )
    throw new Error('Entity reference identity and source must be nonempty strings.');
  for (const value of [row.created_at, row.updated_at])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Entity reference timestamps must be nonnegative integer milliseconds.');
  if (row.workspace_scope !== null && typeof row.workspace_scope !== 'string')
    throw new Error('Entity reference workspace scope is invalid.');
  if (
    row.workspace_root_path !== null &&
    (typeof row.workspace_root_path !== 'string' ||
      !isAbsolutePathLike(row.workspace_root_path) ||
      row.workspace_root_path.includes('\0'))
  )
    throw new Error('Entity reference project root must be absolute.');
  if (row.locator.startsWith('git://') && !row.workspace_root_path)
    throw new Error('Filesystem-backed entity references require an immutable project root.');
  referenceJsonObject(row.deep_link_params);
  referenceJsonObject(row.data);
  resolveMolecularReference(row, { allowLegacyThinView: false });
  classifyAuthoredEntityReference(row);
}

export function prepareEntityReferenceRow(
  params: CreateEntityReferenceParams,
  options: { id?: string; now?: number } = {}
): ChatEntityReferenceIpcRow {
  const now = options.now ?? Date.now();
  const row = {
    id: options.id ?? crypto.randomUUID(),
    entity_type: params.entityType,
    display_label: params.displayLabel,
    locator: params.locator,
    deep_link_params: params.deepLinkParams ? JSON.stringify(params.deepLinkParams) : null,
    data: params.data ? JSON.stringify(params.data) : null,
    source: params.source,
    status: 'created',
    workspace_scope: params.workspaceScope ?? null,
    workspace_root_path: params.workspaceRootPath ?? null,
    created_at: now,
    updated_at: now,
  };
  validatePreparedEntityReferenceRow(row);
  return row;
}

export function isFrozenMolecularReference(reference: ChatEntityReferenceIpcRow): boolean {
  if (reference.entity_type === 'molecular-document') return true;
  if (reference.entity_type !== 'structure' || !reference.data) return false;
  const data = referenceJsonObject(reference.data);
  return (
    data?.kind === 'molecular-view' ||
    data?.kind === 'molecular-view-target' ||
    (data?.kind === 'structure' && data.molecularViewTarget !== undefined)
  );
}

export function sameEntityReferenceContent(
  left: ChatEntityReferenceIpcRow,
  right: ChatEntityReferenceIpcRow
): boolean {
  const content = (row: ChatEntityReferenceIpcRow) => ({
    entityType: row.entity_type,
    label: row.display_label,
    locator: row.locator,
    deepLinkParams: referenceJsonObject(row.deep_link_params),
    data: referenceJsonObject(row.data),
    source: row.source,
    status: row.status,
    workspaceScope: row.workspace_scope,
    workspaceRoot: row.workspace_root_path,
  });
  return canonicalJson(content(left)) === canonicalJson(content(right));
}

export function updatedEntityReferenceRow(
  existing: ChatEntityReferenceIpcRow,
  updates: EntityReferenceUpdates,
  now = Date.now()
): ChatEntityReferenceIpcRow {
  const allowed = new Set(['displayLabel', 'locator', 'deepLinkParams', 'data', 'status']);
  if (!updates || Object.keys(updates).some((key) => !allowed.has(key)))
    throw new Error('Entity reference identity and owner cannot be reassigned.');
  const row = {
    ...existing,
    display_label: updates.displayLabel ?? existing.display_label,
    locator: updates.locator ?? existing.locator,
    deep_link_params:
      updates.deepLinkParams === undefined
        ? existing.deep_link_params
        : updates.deepLinkParams === null
          ? null
          : JSON.stringify(updates.deepLinkParams),
    data:
      updates.data === undefined
        ? existing.data
        : updates.data === null
          ? null
          : JSON.stringify(updates.data),
    status: updates.status ?? existing.status,
    updated_at: now,
  };
  if (sameEntityReferenceContent(existing, row)) return existing;
  if (isFrozenMolecularReference(existing))
    throw new Error(
      'Saved molecular snapshots and their targets are immutable. Save a new result instead.'
    );
  if (
    [
      'sequence',
      'sequence_region',
      'annotation',
      'primer',
      'notebook',
      'alignment',
      'assembly',
      'protein',
      'structure',
    ].includes(existing.entity_type) &&
    (existing.deep_link_params !== row.deep_link_params || existing.data !== row.data)
  )
    throw new Error(
      'Saved entity targets and selections are immutable. Save a new reference instead.'
    );
  validatePreparedEntityReferenceRow(row);
  return row;
}

export function assertEntityReferenceMolecularTarget(
  row: ChatEntityReferenceIpcRow,
  lookup: (id: string) => ChatEntityReferenceIpcRow | null
): void {
  const subject = resolveMolecularReference(row);
  const target =
    subject?.kind === 'view' || subject?.kind === 'selection' ? subject.target : undefined;
  if (!target) return;
  const parent = lookup(target.viewReferenceId);
  const pinned = parent && resolveMolecularReference(parent);
  if (parent?.status !== 'created' || pinned?.kind !== 'visualization' || !pinned.view)
    throw new Error('The pinned molecular view is unavailable.');
  molecularReferenceSnapshotIndex(pinned.view, target);
}
