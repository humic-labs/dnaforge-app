import type { SequencePackageDocument, SequencePackageRevision } from './sequence-package';
import type { SequenceRestoreSelection } from '../shared/sequence-package-revision';
import { validatedSequenceEntityRegistrationStatus } from '../shared/entity-record';

export const RESTORE_PRODUCT_ITEM = 'product' as const;
export const RESTORE_TOPOLOGY_ITEM = 'topology' as const;
export const RESTORE_GENETIC_CODE_ITEM = 'genetic-code' as const;
export const RESTORE_NAME_ITEM = 'name' as const;
export const RESTORE_SCHEMA_ITEM = 'schema' as const;
export const RESTORE_ASSEMBLY_ITEM = 'assembly' as const;
export const RESTORE_STATUS_ITEM = 'status' as const;
export const RESTORE_RELATIONSHIPS_ITEM = 'relationships' as const;
export const RESTORE_SOURCE_ITEM = 'source' as const;
const FIELD_PREFIX = 'field:';
const USER_ATTACHMENT_PREFIX = 'user-attachment:';
const ANNOTATION_PREFIX = 'annotation:';

export interface RestoreItem {
  id: string;
  label: string;
  sourceRevisionIds: string[];
}

export function restoreFieldItemId(key: string): string {
  return `${FIELD_PREFIX}${encodeURIComponent(key)}`;
}

export function restoreUserAttachmentItemId(attachmentId: string): string {
  return `${USER_ATTACHMENT_PREFIX}${encodeURIComponent(attachmentId)}`;
}

export function restoreAnnotationItemId(annotationId: string): string {
  return `${ANNOTATION_PREFIX}${annotationId}`;
}

export function annotationIdForRestoreItem(itemId: string): string | null {
  if (!itemId.startsWith(ANNOTATION_PREFIX)) return null;
  const id = itemId.slice(ANNOTATION_PREFIX.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw new Error(`Invalid managed annotation identity: ${itemId}`);
  }
  return id;
}

export function userAttachmentIdForRestoreItem(itemId: string): string | null {
  if (!itemId.startsWith(USER_ATTACHMENT_PREFIX)) return null;
  const id = decodeURIComponent(itemId.slice(USER_ATTACHMENT_PREFIX.length));
  if (!id || restoreUserAttachmentItemId(id) !== itemId) {
    throw new Error(`Invalid user attachment identity: ${itemId}`);
  }
  return id;
}

export function sequenceRestoreItemCatalog(document: SequencePackageDocument): RestoreItem[] {
  const revisions = document.versionHistory.revisions;
  const every = revisions.map((revision) => revision.id);
  const topologySources = revisions
    .filter(
      (revision) =>
        revision.state.product.topology === 'linear' ||
        revision.state.product.topology === 'circular'
    )
    .map((revision) => revision.id);
  const geneticCodeSources = revisions
    .filter((revision) => Object.prototype.hasOwnProperty.call(revision.state, 'geneticCode'))
    .map((revision) => revision.id);
  const fieldKeys = new Set<string>();
  for (const revision of revisions) {
    for (const key of Object.keys(revision.state.entity.fields)) fieldKeys.add(key);
    for (const field of revision.state.entity.schema.fields) {
      if (!field.intrinsic) fieldKeys.add(field.key);
    }
  }
  for (const key of Object.keys(document.entity.fields)) fieldKeys.add(key);
  const labels = new Map<string, string>();
  for (const revision of revisions) {
    for (const field of revision.state.entity.schema.fields) labels.set(field.key, field.label);
  }
  for (const field of document.entity.schema.fields) labels.set(field.key, field.label);
  const attachmentIds = new Set(Object.keys(document.userAttachments));
  for (const revision of revisions) {
    for (const id of Object.keys(revision.state.userAttachments ?? {})) attachmentIds.add(id);
  }
  const annotationLabels = new Map<string, string>();
  for (const revision of revisions) {
    for (const annotation of revision.state.annotationItems ?? []) {
      annotationLabels.set(annotation.id, annotation.label);
    }
  }
  return [
    {
      id: RESTORE_PRODUCT_ITEM,
      label: 'Complete sequence product snapshot',
      sourceRevisionIds: every,
    },
    { id: RESTORE_TOPOLOGY_ITEM, label: 'Topology', sourceRevisionIds: topologySources },
    { id: RESTORE_GENETIC_CODE_ITEM, label: 'Genetic code', sourceRevisionIds: geneticCodeSources },
    { id: RESTORE_NAME_ITEM, label: 'Name', sourceRevisionIds: every },
    { id: RESTORE_SCHEMA_ITEM, label: 'Schema', sourceRevisionIds: every },
    ...[...fieldKeys].sort().map((key) => ({
      id: restoreFieldItemId(key),
      label: labels.get(key) ?? key,
      sourceRevisionIds: every,
    })),
    { id: RESTORE_ASSEMBLY_ITEM, label: 'Saved assembly', sourceRevisionIds: every },
    { id: RESTORE_STATUS_ITEM, label: 'Status', sourceRevisionIds: every },
    { id: RESTORE_RELATIONSHIPS_ITEM, label: 'Relationships', sourceRevisionIds: every },
    { id: RESTORE_SOURCE_ITEM, label: 'Source metadata', sourceRevisionIds: every },
    ...[...attachmentIds].sort().map((attachmentId) => {
      const current = document.userAttachments[attachmentId];
      const member = document.members.find((candidate) => candidate.id === current?.memberId);
      return {
        id: restoreUserAttachmentItemId(attachmentId),
        label: member?.path.split('/').slice(-1)[0] ?? `Attachment ${attachmentId}`,
        sourceRevisionIds: revisions
          .filter((revision) => {
            const state = revision.state.userAttachments;
            if (state === undefined) return false;
            const entry = state[attachmentId];
            return entry === undefined || entry.sha256 !== null;
          })
          .map((revision) => revision.id),
      };
    }),
    ...[...annotationLabels]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([annotationId, label]) => ({
        id: restoreAnnotationItemId(annotationId),
        label: `Annotation: ${label}`,
        sourceRevisionIds: revisions
          .filter((revision) => revision.state.annotationItems !== undefined)
          .map((revision) => revision.id),
      })),
  ];
}

export function sourceValueForRestoreItem(
  revision: SequencePackageRevision,
  itemId: string
): { present: boolean; value: unknown } {
  const state = revision.state;
  switch (itemId) {
    case RESTORE_PRODUCT_ITEM:
      return { present: true, value: revision.productSnapshot };
    case RESTORE_TOPOLOGY_ITEM:
      return {
        present: revision.state.product.topology !== undefined,
        value: revision.state.product.topology,
      };
    case RESTORE_GENETIC_CODE_ITEM:
      return {
        present: Object.prototype.hasOwnProperty.call(revision.state, 'geneticCode'),
        value: revision.state.geneticCode,
      };
    case RESTORE_NAME_ITEM:
      return { present: true, value: state.name };
    case RESTORE_SCHEMA_ITEM:
      return { present: true, value: state.entity.schema };
    case RESTORE_ASSEMBLY_ITEM:
      return { present: state.acceptedAssembly !== null, value: state.acceptedAssembly };
    case RESTORE_STATUS_ITEM:
      return { present: true, value: state.entity.domainStatus };
    case RESTORE_RELATIONSHIPS_ITEM:
      return { present: true, value: state.entity.relationships };
    case RESTORE_SOURCE_ITEM:
      return {
        present: Object.prototype.hasOwnProperty.call(state.entity, 'source'),
        value: state.entity.source,
      };
    default: {
      const annotationId = annotationIdForRestoreItem(itemId);
      if (annotationId !== null) {
        if (state.annotationItems === undefined) {
          throw new Error(`Revision ${revision.id} has no verified annotation identities.`);
        }
        const value = state.annotationItems.find((item) => item.id === annotationId);
        return { present: value !== undefined, value };
      }
      const attachmentId = userAttachmentIdForRestoreItem(itemId);
      if (attachmentId !== null) {
        if (state.userAttachments === undefined) {
          throw new Error(`Revision ${revision.id} has no verified attachment history.`);
        }
        const value = state.userAttachments[attachmentId];
        if (value?.sha256 === null) {
          throw new Error(`Revision ${revision.id} did not verify attachment ${attachmentId}.`);
        }
        return { present: value !== undefined, value };
      }
      if (!itemId.startsWith(FIELD_PREFIX)) throw new Error(`Unknown restore item: ${itemId}`);
      const key = decodeURIComponent(itemId.slice(FIELD_PREFIX.length));
      if (!key || restoreFieldItemId(key) !== itemId) {
        throw new Error(`Invalid restore field identity: ${itemId}`);
      }
      return {
        present: Object.prototype.hasOwnProperty.call(state.entity.fields, key),
        value: state.entity.fields[key],
      };
    }
  }
}

export function composeSequenceRestore(input: {
  current: SequencePackageDocument;
  selections: readonly SequenceRestoreSelection[];
  revisions: readonly SequencePackageRevision[];
}): { next: SequencePackageDocument; blockers: string[] } {
  const next = structuredClone(input.current);
  const knownItems = new Set(sequenceRestoreItemCatalog(input.current).map((item) => item.id));
  const seen = new Set<string>();
  const blockers: string[] = [];
  for (const selection of input.selections) {
    if (!knownItems.has(selection.itemId))
      throw new Error(`Unknown restore item: ${selection.itemId}`);
    if (seen.has(selection.itemId)) throw new Error(`Duplicate restore item: ${selection.itemId}`);
    seen.add(selection.itemId);
    const revision = input.revisions.find((candidate) => candidate.id === selection.revisionId);
    if (!revision) throw new Error(`Unknown restore source: ${selection.revisionId}`);
    const source = sourceValueForRestoreItem(revision, selection.itemId);
    switch (selection.itemId) {
      case RESTORE_PRODUCT_ITEM:
        next.product = { ...revision.state.product, file: input.current.product.file };
        break;
      case RESTORE_TOPOLOGY_ITEM:
        if (source.present) next.product.topology = revision.state.product.topology;
        else blockers.push('The selected version did not record topology.');
        break;
      case RESTORE_GENETIC_CODE_ITEM:
        if (!source.present) blockers.push('The selected version did not record genetic code.');
        break;
      case RESTORE_NAME_ITEM:
        next.name = revision.state.name;
        break;
      case RESTORE_SCHEMA_ITEM:
        next.entity.schema = structuredClone(revision.state.entity.schema);
        break;
      case RESTORE_ASSEMBLY_ITEM:
        if (source.present) {
          next.assembly = {
            accepted: structuredClone(revision.state.acceptedAssembly!),
            ...(next.assembly?.history ? { history: next.assembly.history } : {}),
          };
        } else {
          if (next.assembly?.history?.length) {
            next.assembly = { history: structuredClone(next.assembly.history) };
          } else {
            delete next.assembly;
          }
        }
        break;
      case RESTORE_STATUS_ITEM:
        next.entity.domainStatus = revision.state.entity.domainStatus;
        break;
      case RESTORE_RELATIONSHIPS_ITEM:
        next.entity.relationships = structuredClone(revision.state.entity.relationships);
        break;
      case RESTORE_SOURCE_ITEM:
        if (source.present) next.entity.source = structuredClone(revision.state.entity.source);
        else delete next.entity.source;
        break;
      default: {
        if (annotationIdForRestoreItem(selection.itemId) !== null) {
          break;
        }
        const attachmentId = userAttachmentIdForRestoreItem(selection.itemId);
        if (attachmentId !== null) {
          if (source.present) {
            next.userAttachments[attachmentId] = structuredClone(
              source.value as NonNullable<(typeof next.userAttachments)[string]>
            );
          } else {
            delete next.userAttachments[attachmentId];
          }
          break;
        }
        const key = decodeURIComponent(selection.itemId.slice(FIELD_PREFIX.length));
        if (source.present) next.entity.fields[key] = structuredClone(source.value);
        else delete next.entity.fields[key];
      }
    }
  }
  const finalFieldKeys = new Set(next.entity.schema.fields.map((field) => field.key));
  for (const selection of input.selections) {
    if (!selection.itemId.startsWith(FIELD_PREFIX)) continue;
    const key = decodeURIComponent(selection.itemId.slice(FIELD_PREFIX.length));
    if (!finalFieldKeys.has(key)) {
      blockers.push(`Field "${key}" is not declared by the selected schema.`);
    }
  }
  if (input.selections.some((selection) => selection.itemId === RESTORE_SCHEMA_ITEM)) {
    for (const key of Object.keys(next.entity.fields)) {
      if (!finalFieldKeys.has(key)) {
        blockers.push(`Retained field "${key}" is not declared by the selected schema.`);
      }
    }
  }
  for (const relationship of next.entity.relationships) {
    if (relationship.fromEntityId !== next.id && relationship.toEntityId !== next.id) {
      blockers.push(`Relationship "${relationship.type}" does not belong to this entity.`);
    }
  }
  try {
    next.entity.registrationStatus = validatedSequenceEntityRegistrationStatus(
      next.entity.schema,
      next.entity.fields,
      next.entity.registrationStatus
    );
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : 'Restored schema fields are invalid.');
  }
  return { next, blockers };
}
