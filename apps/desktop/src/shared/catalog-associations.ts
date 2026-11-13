import {
  isCatalogRecordPresentationKind,
  type CatalogRecordPresentationKind,
} from './catalog-entity';
import { isSafeWorkspaceRelativePath } from './path-boundary';

export type CatalogConfidence = 'suggested' | 'confirmed' | 'rejected';
export interface CatalogEntityLinkInput {
  sourceEntityId: string;
  relation: string;
  targetEntityId: string;
  confidence?: CatalogConfidence;
  evidence?: Record<string, unknown> | null;
}
export interface CatalogEntityLinkRow {
  id: string;
  source_entity_id: string;
  relation: string;
  target_entity_id: string;
  confidence: CatalogConfidence;
  evidence: string | null;
  created_at: number;
  updated_at: number;
}
export interface CatalogEventInput {
  id?: string;
  entityId: string;
  eventType: string;
  actor?: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: number;
}
export interface CatalogEventRow {
  id: string;
  entity_id: string;
  event_type: string;
  actor: string;
  summary: string | null;
  payload: string | null;
  created_at: number;
}
export interface CatalogEntityPresentationInput {
  entityId: string;
  name?: string;
  metadataPatch?: Record<string, unknown>;
}
export type CatalogWorkspacePlacementStatus = 'active' | 'hidden';
export interface CatalogWorkspacePlacementInput {
  entityId: string;
  workspaceId: number;
  parentRelativePath: string;
  displayName: string;
  presentationKind: CatalogRecordPresentationKind;
  status?: CatalogWorkspacePlacementStatus;
}
export interface CatalogWorkspacePlacementRow {
  entity_id: string;
  workspace_id: number;
  parent_relative_path: string;
  display_name: string;
  normalized_sibling_name: string;
  presentation_kind: CatalogRecordPresentationKind;
  status: CatalogWorkspacePlacementStatus;
  created_at: number;
  updated_at: number;
}
export interface RestoreCatalogProviderBindingInput {
  provider: string;
  stableObjectId: string;
  objectClass: string;
  entityId: string;
  bindingKind: 'observed' | 'reviewed';
  providerAccountHint?: string | null;
  canonicalUrl?: string | null;
  evidence: Record<string, unknown>;
}
export interface ArchiveSupersededNotebookCatalogInput {
  sourceEntityId: string;
  successorEntityId: string;
  workspaceId: number;
}

export function requireCatalogText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error(`Catalog ${field} is invalid.`);
  return value;
}
export function normalizeCatalogDisplayName(value: string): string {
  return requireCatalogText(value, 'display name').trim().normalize('NFC');
}
export function normalizeCatalogSiblingName(value: string): string {
  return normalizeCatalogDisplayName(value).toLowerCase();
}
export function normalizeCatalogParentRelativePath(value: string): string {
  if (typeof value !== 'string') throw new Error('Catalog parent path is invalid.');
  const path = value.normalize('NFC').replace(/\\/g, '/');
  if (
    path !== '' &&
    (!isSafeWorkspaceRelativePath(path) ||
      ['.git', '.dnaforge', '.forge', '.waypoint'].includes(path.split('/')[0].toLowerCase()))
  )
    throw new Error('Catalog parent path is unsafe.');
  return path;
}
export function normalizeCatalogPlacement(input: CatalogWorkspacePlacementInput) {
  if (!input || typeof input !== 'object') throw new Error('Catalog placement is invalid.');
  requireCatalogText(input.entityId, 'entity identity');
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId <= 0)
    throw new Error('Catalog placement workspace ID is invalid.');
  if (!isCatalogRecordPresentationKind(input.presentationKind))
    throw new Error('Catalog placement presentation kind is unsupported.');
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'hidden')
    throw new Error('Catalog placement status is unsupported.');
  return {
    ...input,
    parentRelativePath: normalizeCatalogParentRelativePath(input.parentRelativePath),
    displayName: normalizeCatalogDisplayName(input.displayName),
    normalizedSiblingName: normalizeCatalogSiblingName(input.displayName),
    status,
  };
}
export function catalogJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Catalog ${field} must be an object.`);
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    Object.keys(value).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))
  )
    throw new Error(`Catalog ${field} is invalid.`);
  return JSON.parse(serialized) as Record<string, unknown>;
}
