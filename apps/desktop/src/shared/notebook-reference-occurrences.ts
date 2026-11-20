import type { JSONContent } from '@tiptap/core';
import type { Cell } from './table-document-types';
import { contentFingerprint } from './content-fingerprint';
import { nativeEntityReferenceIdFromHref } from './native-entity-reference';
import { savedReferenceIdFromHref } from './saved-reference-url';
import {
  projectResourceReferenceHref,
  projectResourceReferenceSchema,
} from './project-resource-reference';
import { isTableCellContent } from './table-cell-content';

export const NOTEBOOK_REFERENCE_EXTRACTOR_VERSION = 1;

export interface NotebookReferenceOccurrence {
  occurrenceId: string;
  targetEntityId: string | null;
  targetKind: 'entity' | 'saved-reference' | 'resource' | 'unresolved';
  targetReference: string | null;
  entityType: string | null;
  representationId: string | null;
  versionId: string | null;
}

export interface NotebookReferenceOccurrenceInspection {
  occurrences: NotebookReferenceOccurrence[];
  missingOccurrenceCount: number;
}

function identity(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function targetFor(node: JSONContent): Omit<NotebookReferenceOccurrence, 'occurrenceId'> {
  const attrs = node.attrs ?? {};
  const entityType = identity(attrs.entityType);
  if (entityType === 'table-migration-destination')
    return {
      targetEntityId: null,
      targetKind: 'unresolved',
      targetReference: identity(attrs.migrationDestinationId),
      entityType: null,
      representationId: null,
      versionId: null,
    };
  const referenceUri = identity(attrs.referenceUri);
  const resource = projectResourceReferenceSchema.safeParse(attrs.resourceReference);
  const entityId =
    (resource.success && resource.data.kind === 'entity' ? resource.data.entityId : null) ??
    identity(attrs.entityId) ??
    (referenceUri ? nativeEntityReferenceIdFromHref(referenceUri) : null) ??
    (entityType !== 'reference' && entityType !== 'project-resource' ? identity(attrs.id) : null);
  const targetReference = resource.success
    ? projectResourceReferenceHref(resource.data)
    : referenceUri;
  return {
    targetEntityId: entityId,
    targetKind: entityId
      ? 'entity'
      : referenceUri && savedReferenceIdFromHref(referenceUri)
        ? 'saved-reference'
        : resource.success || referenceUri
          ? 'resource'
          : 'unresolved',
    targetReference,
    entityType,
    representationId: identity(attrs.representationId),
    versionId: identity(attrs.versionId),
  };
}

function mapReferenceNodes(
  node: JSONContent,
  path: string,
  visit: (node: JSONContent, path: string) => JSONContent
): JSONContent {
  if (node.type === 'mention') return visit(node, path);
  if (node.type === 'codeBlock' || node.type === 'rawMarkdown') return node;
  if (node.type === 'embed') {
    if (node.attrs?.type !== 'table' || !Array.isArray(node.attrs.data?.cells)) return node;
    let changed = false;
    const cells = node.attrs.data.cells.map((row: unknown, rowIndex: number) => {
      if (!Array.isArray(row)) return row;
      return row.map((cell: unknown, columnIndex: number) => {
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return cell;
        const value = cell as Record<string, unknown>;
        let next = value;
        const reference = value.reference;
        if (reference && typeof reference === 'object' && !Array.isArray(reference)) {
          const data = reference as Record<string, unknown>;
          const native = data.kind === 'native-entity' && identity(data.entityId);
          const legacy =
            data.kind === 'migration-destination' && identity(data.destinationTargetId);
          if (native || legacy) {
            const referenceNode: JSONContent = {
              type: 'mention',
              attrs: {
                occurrenceId: data.occurrenceId ?? null,
                entityType: native ? 'native-catalog-exact' : 'table-migration-destination',
                entityId: native || null,
                migrationDestinationId: legacy || null,
                label: typeof value.value === 'string' ? value.value : '',
              },
            };
            const mapped = visit(
              referenceNode,
              `${path}/cells/${rowIndex}/${columnIndex}/reference`
            );
            if (mapped.attrs?.occurrenceId !== referenceNode.attrs?.occurrenceId)
              next = { ...next, reference: { ...data, occurrenceId: mapped.attrs?.occurrenceId } };
          }
        }
        if (isTableCellContent(value.content)) {
          const previousContent = value.content;
          const content = previousContent.map((child, index) =>
            mapReferenceNodes(child, `${path}/cells/${rowIndex}/${columnIndex}/${index}`, visit)
          );
          if (!content.every((child, index) => child === previousContent[index]))
            next = { ...next, content };
        }
        if (next !== value) changed = true;
        return next;
      });
    });
    return changed
      ? { ...node, attrs: { ...node.attrs, data: { ...node.attrs.data, cells } } }
      : node;
  }
  if (!Array.isArray(node.content)) return node;
  const content = node.content.map((child, index) =>
    mapReferenceNodes(child, `${path}/content/${index}`, visit)
  );
  return content.every((child, index) => child === node.content![index])
    ? node
    : { ...node, content };
}

export function mapNotebookReferenceNodes(
  content: JSONContent,
  visit: (node: JSONContent, path: string) => JSONContent
): JSONContent {
  return mapReferenceNodes(content, '', visit);
}

export function inspectNotebookReferenceOccurrences(
  content: JSONContent
): NotebookReferenceOccurrenceInspection {
  const occurrences: NotebookReferenceOccurrence[] = [];
  const seen = new Set<string>();
  let missingOccurrenceCount = 0;
  mapReferenceNodes(content, '', (node) => {
    const occurrenceId = identity(node.attrs?.occurrenceId);
    if (!occurrenceId) missingOccurrenceCount++;
    else {
      if (seen.has(occurrenceId))
        throw new Error('Notebook reference occurrence IDs must be unique.');
      seen.add(occurrenceId);
      occurrences.push({ occurrenceId, ...targetFor(node) });
    }
    return node;
  });
  return { occurrences, missingOccurrenceCount };
}

export function extractNotebookReferenceOccurrences(
  content: JSONContent
): NotebookReferenceOccurrence[] {
  return inspectNotebookReferenceOccurrences(content).occurrences;
}

export function normalizeNotebookReferenceOccurrences(
  content: JSONContent,
  options: { documentId: string; createId?: () => string; reassign?: boolean }
): JSONContent {
  if (!identity(options.documentId)) throw new Error('Notebook occurrence owner is invalid.');
  const reserved = new Set<string>();
  mapReferenceNodes(content, '', (node) => {
    const id = identity(node.attrs?.occurrenceId);
    if (id) reserved.add(id);
    return node;
  });
  const seen = new Set<string>();
  return mapReferenceNodes(content, '', (node, path) => {
    const current = identity(node.attrs?.occurrenceId);
    if (!options.reassign && current && !seen.has(current)) {
      seen.add(current);
      return node;
    }
    const base = `legacy-${contentFingerprint(
      JSON.stringify([options.documentId, path, targetFor(node)])
    )}`;
    let next = options.createId?.() ?? (options.reassign ? crypto.randomUUID() : base);
    if (!identity(next)) throw new Error('Notebook reference occurrence identity is invalid.');
    if (options.createId && (reserved.has(next) || seen.has(next)))
      throw new Error('Notebook reference occurrence identity generator returned a duplicate.');
    for (let suffix = 1; reserved.has(next) || seen.has(next); suffix++) next = `${base}-${suffix}`;
    seen.add(next);
    reserved.add(next);
    return { ...node, attrs: { ...node.attrs, occurrenceId: next } };
  });
}

export function copyTableCellReferenceOccurrences(cell: Cell, createId?: () => string): Cell {
  const table = normalizeNotebookReferenceOccurrences(
    { type: 'embed', attrs: { type: 'table', data: { cells: [[cell]] } } },
    { documentId: 'table-copy', reassign: true, createId }
  );
  return table.attrs!.data.cells[0][0] as Cell;
}
