import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import { coordinateDigest, type MolecularView } from './molecular-view';
import type { MolecularDocument } from './molecular-document';
import { scopedProjectionId } from './workspace-scoped-identity';
import type { ChatEntityReferenceIpcRow } from './entity-reference-types';

export const molecularDocumentReferenceSchema = z
  .object({
    kind: z.literal('molecular-document'),
    version: z.literal(1),
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,499}$/),
    documentId: z.string().uuid(),
    revisionId: z.string().uuid(),
    revisionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    viewId: z.string().min(1).max(1000).optional(),
    groupId: z.string().min(1).max(1000).optional(),
  })
  .strict();

export type MolecularDocumentReference = z.infer<typeof molecularDocumentReferenceSchema>;

export function molecularDocumentReferenceLocator(reference: MolecularDocumentReference): string {
  const value = molecularDocumentReferenceSchema.parse(reference);
  if (value.groupId && !value.viewId)
    throw Error('A molecular group reference requires its named view identity.');
  return `entity://molecular-document/${encodeURIComponent(value.projectId)}/${value.documentId}/revisions/${value.revisionId}/sha256/${value.revisionSha256}${value.viewId ? `/views/${encodeURIComponent(value.viewId)}` : ''}${value.groupId ? `/groups/${encodeURIComponent(value.groupId)}` : ''}`;
}

export function molecularDocumentReferenceHref(reference: MolecularDocumentReference): string {
  return molecularDocumentReferenceLocator(reference).replace('entity://', 'dnaforge-chat://');
}

export function molecularDocumentReferenceFromHref(
  href: string
): MolecularDocumentReference | null {
  if (new TextEncoder().encode(href).byteLength > 2048) return null;
  const match =
    /^(?:entity|dnaforge-chat):\/\/molecular-document\/([^/?#]+)\/([^/?#]+)\/revisions\/([^/?#]+)\/sha256\/([a-f0-9]{64})(?:\/views\/([^/?#]+)(?:\/groups\/([^/?#]+))?)?$/.exec(
      href
    );
  if (!match) return null;
  try {
    return molecularDocumentReferenceSchema.parse({
      kind: 'molecular-document',
      version: 1,
      projectId: decodeURIComponent(match[1]),
      documentId: match[2],
      revisionId: match[3],
      revisionSha256: match[4],
      ...(match[5] ? { viewId: decodeURIComponent(match[5]) } : {}),
      ...(match[6] ? { groupId: decodeURIComponent(match[6]) } : {}),
    });
  } catch {
    return null;
  }
}

export function molecularDocumentReferenceRecord(
  reference: MolecularDocumentReference,
  label: string,
  id = reference.revisionId,
  workspaceRoot: string | null = null
): ChatEntityReferenceIpcRow {
  return {
    id,
    entity_type: 'molecular-document',
    display_label: label,
    locator: molecularDocumentReferenceLocator(reference),
    data: JSON.stringify(reference),
    deep_link_params: null,
    source: 'user',
    status: 'created',
    workspace_scope: reference.projectId,
    workspace_root_path: workspaceRoot,
    created_at: 0,
    updated_at: 0,
  };
}

export function molecularDocumentCatalogId(reference: MolecularDocumentReference): string {
  return scopedProjectionId(reference.projectId, reference.documentId);
}

export function molecularDocumentRevision(
  document: MolecularDocument,
  revisionId: string
): MolecularView {
  const entry = document.history.find((item) => item.referenceId === revisionId);
  if (!entry) throw Error('The requested molecular document revision does not exist.');
  return entry.snapshot;
}

export async function molecularDocumentRevisionDigest(snapshot: MolecularView): Promise<string> {
  return coordinateDigest(canonicalJson(snapshot));
}

export async function molecularDocumentReferenceFor(
  projectId: string,
  document: MolecularDocument,
  revisionId = document.currentReferenceId,
  viewId?: string
): Promise<MolecularDocumentReference> {
  const snapshot = molecularDocumentRevision(document, revisionId);
  return molecularDocumentReferenceSchema.parse({
    kind: 'molecular-document',
    version: 1,
    projectId,
    documentId: document.id,
    revisionId,
    revisionSha256: await molecularDocumentRevisionDigest(snapshot),
    ...(viewId ? { viewId } : {}),
  });
}

export function molecularDocumentReferenceFromData(
  data: string | null
): MolecularDocumentReference | null {
  if (!data) return null;
  try {
    const value = JSON.parse(data);
    if (value?.kind !== 'molecular-document') return null;
    return molecularDocumentReferenceSchema.parse(value);
  } catch {
    return null;
  }
}
