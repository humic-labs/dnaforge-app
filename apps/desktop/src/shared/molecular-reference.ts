import {
  molecularViewSchema,
  molecularViewTargetSchema,
  molecularViewDocumentIdentitySchema,
  type MolecularView,
  type MolecularViewTarget,
} from './molecular-view';
import { hasCompleteMolecularResidueIdentities } from './structure-selection-identity';
import {
  molecularDocumentReferenceSchema,
  molecularDocumentReferenceLocator,
  type MolecularDocumentReference,
} from './molecular-document-reference';

interface ReferenceIdentity {
  entity_type: string;
  locator: string;
  data: string | null;
}

export type MolecularReference =
  | { kind: 'document'; document: MolecularDocumentReference }
  | { kind: 'structure'; structureId: string }
  | { kind: 'selection'; descriptor: Record<string, unknown>; target?: MolecularViewTarget }
  | { kind: 'visualization'; view: MolecularView | null }
  | { kind: 'view'; target: MolecularViewTarget };

export function molecularViewTargetLocator(target: MolecularViewTarget): string {
  return `entity://molecular-view-target/${target.viewReferenceId}/${encodeURIComponent(target.viewId ?? String(target.snapshotIndex))}/${encodeURIComponent(target.groupId ?? 'view')}`;
}

export function molecularReferenceSnapshotIndex(
  view: MolecularView,
  target: { viewId?: string; snapshotIndex?: number }
): number {
  const document = JSON.parse(view.scene);
  const views = document.kind === 'multiple' ? document.snapshots : [document];
  if (!Array.isArray(views) || !views.length)
    throw Error('The pinned molecular view does not exist.');
  const matches = views.flatMap((step, index) =>
    step.metadata?.key === target.viewId ? [index] : []
  );
  if (target.viewId !== undefined && matches.length !== 1)
    throw Error('The pinned molecular view identity is missing or ambiguous.');
  const index = target.viewId !== undefined ? matches[0] : target.snapshotIndex;
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= views.length)
    throw Error('The pinned molecular view does not exist.');
  if (
    target.viewId !== undefined &&
    target.snapshotIndex !== undefined &&
    target.snapshotIndex !== index
  )
    throw Error('The molecular view identity disagrees with its snapshot index.');
  return index;
}

export function resolveMolecularReference(
  reference: ReferenceIdentity,
  { allowLegacyThinView = true }: { allowLegacyThinView?: boolean } = {}
): MolecularReference | null {
  const saved = reference.locator.startsWith('entity://structure/saved-view:');
  const destination = reference.locator.startsWith('entity://molecular-view-target/');
  const document = reference.locator.startsWith('entity://structure/molecular-document:');
  let data: Record<string, unknown> | null = null;
  if (reference.data) {
    try {
      const value: unknown = JSON.parse(reference.data);
      if (value && typeof value === 'object' && !Array.isArray(value))
        data = value as Record<string, unknown>;
    } catch {}
  }
  if (
    reference.entity_type === 'molecular-document' ||
    data?.kind === 'molecular-document' ||
    reference.locator.startsWith('entity://molecular-document/')
  ) {
    const documentReference = molecularDocumentReferenceSchema.parse(
      data?.kind === 'structure' ? data.molecularDocumentReference : data
    );
    if (
      reference.entity_type !== 'molecular-document' ||
      reference.locator !== molecularDocumentReferenceLocator(documentReference)
    )
      throw Error('The molecular document reference type or locator disagrees with its target.');
    return { kind: 'document', document: documentReference };
  }
  const molecular = data?.kind === 'molecular-view' || data?.kind === 'molecular-view-target';
  if (reference.entity_type !== 'structure') {
    if (saved || destination || document || molecular)
      throw Error('The molecular reference type disagrees with its target.');
    return null;
  }
  if (data?.kind === 'molecular-view') {
    const result = molecularViewSchema.safeParse(data);
    if (!saved || !result.success)
      throw Error('This saved molecular view has an invalid or unsupported snapshot.');
    return { kind: 'visualization', view: result.data };
  }
  if (data?.kind === 'molecular-view-target') {
    const result = molecularViewTargetSchema.safeParse(data);
    if (!result.success || reference.locator !== molecularViewTargetLocator(result.data))
      throw Error('The molecular view target disagrees with its locator.');
    return { kind: 'view', target: result.data };
  }
  if (data?.kind === 'structure' && data.molecularViewTarget) {
    if (!hasCompleteMolecularResidueIdentities(data))
      throw Error('A view-bound selection requires identity-complete residue identities.');
    const target = molecularViewTargetSchema.parse(data.molecularViewTarget);
    if (reference.locator !== molecularViewTargetLocator(target))
      throw Error('The molecular selection disagrees with its pinned view target.');
    return { kind: 'selection', descriptor: data, target };
  }
  if (saved && !reference.data && allowLegacyThinView) return { kind: 'visualization', view: null };
  if (saved || destination || document)
    throw Error('A molecular document or view requires its explicit molecular target.');
  const structureId = reference.locator.replace(/^entity:\/\/structure\//, '');
  if (data?.kind === 'structure') {
    if (reference.locator.startsWith('entity://structure/')) {
      const measured =
        data.measured && typeof data.measured === 'object'
          ? (data.measured as Record<string, unknown>)
          : null;
      const locator =
        data.locator && typeof data.locator === 'object'
          ? (data.locator as Record<string, unknown>)
          : null;
      if (
        !structureId ||
        measured?.structureRef !== structureId ||
        (locator?.path !== undefined && locator.path !== structureId) ||
        (locator?.structureRef !== undefined && locator.structureRef !== structureId)
      )
        throw Error('The structure selection disagrees with its canonical structure source.');
    }
    return { kind: 'selection', descriptor: data };
  }
  return { kind: 'structure', structureId };
}

interface MolecularViewerIdentity {
  molViewSpec?: string;
  molViewSpecSavedReferenceId?: string;
  molecularDocumentId?: string;
  molecularDocumentPath?: string;
  molecularDocumentRevision?: string;
  molecularDocumentSavedReferenceId?: string;
}

export function resolveMolecularViewerSubject(
  structureViewId: string,
  attrs: MolecularViewerIdentity
):
  | { kind: 'structure'; structureId: string }
  | {
      kind: 'view';
      document?: NonNullable<MolecularViewTarget['document']>;
    } {
  const document = Boolean(
    attrs.molecularDocumentId ||
    attrs.molecularDocumentPath ||
    structureViewId.startsWith('molecular-document:')
  );
  if (document) {
    if (!attrs.molViewSpec)
      throw Error('The molecular document identity or displayed view is unavailable.');

    const binding = molecularViewDocumentIdentitySchema.safeParse({
      id: attrs.molecularDocumentId,
      path: attrs.molecularDocumentPath,
      revision: attrs.molecularDocumentRevision,
      savedReferenceId: attrs.molecularDocumentSavedReferenceId,
    });
    if (!binding.success)
      throw Error('The molecular document identity or revision is unavailable. Reopen its file.');
    return { kind: 'view', document: binding.data };
  }
  if (
    attrs.molViewSpec ||
    attrs.molViewSpecSavedReferenceId ||
    structureViewId.startsWith('saved-view:')
  )
    return { kind: 'view' };
  return { kind: 'structure', structureId: structureViewId };
}
