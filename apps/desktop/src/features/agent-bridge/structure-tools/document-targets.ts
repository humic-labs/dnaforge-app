import { useCanvasStore } from '../../canvas/public/store';
import { resolveWorkspaceScope } from '../../../db/workspace-catalog';
import {
  molecularDocumentReferenceFromHref,
  molecularDocumentReferenceHref,
  type MolecularDocumentReference,
} from '../../../shared/molecular-document-reference';
import type { MolecularView } from '../../../shared/molecular-view';
import { molecularViewReferenceTargets } from '../../page/public/embeds/structure3d/molecularView';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { Structure3dAttrs } from '../../page/public/embeds/structure3d/types';
import { openMolecularDocument } from '../../molecular-documents/public/open';
import { resolveMolecularDocumentReference } from '../../molecular-documents/public/references';
import { throwStructureError } from './errors';

export async function requireMolecularDocumentTarget(target?: string) {
  const reference = target ? molecularDocumentReferenceFromHref(target) : null;
  if (reference) await resolveMolecularDocumentReference(reference);
  return reference;
}

export function molecularDocumentTargetCandidates<
  T extends { registrationId: string; entry: { data: Structure3dAttrs } },
>(target: string, candidates: T[]): T[] | null {
  const reference = molecularDocumentReferenceFromHref(target);
  if (!reference) return null;
  return candidates.filter(
    ({ registrationId, entry: { data } }) =>
      data.molecularDocumentId === reference.documentId &&
      (data.molecularDocumentProjectId === reference.projectId ||
        registrationId.startsWith(
          `molecular-document:${reference.projectId}::${reference.documentId}`
        )) &&
      (data.molecularDocumentHistoricalRevisionId ?? data.molecularDocumentSavedReferenceId) ===
        reference.revisionId
  );
}

export async function openMolecularDocumentTarget(
  reference: MolecularDocumentReference,
  context: { folders?: WorkspaceFolder[]; abortSignal?: AbortSignal }
) {
  const scopes = await Promise.all(
    (context.folders ?? []).map((folder) => resolveWorkspaceScope(folder.path))
  );
  if (!scopes.includes(reference.projectId))
    throwStructureError(
      'OUTSIDE_WORKSPACE',
      'The molecular document does not belong to this agent’s mounted projects.'
    );
  const resolved = await resolveMolecularDocumentReference(reference);
  const opened = await openMolecularDocument(resolved.saved.path, {
    workspaceRoot: resolved.saved.workspaceRoot,
    revisionId: reference.revisionId,
    viewId: reference.viewId,
    reference,
    signal: context.abortSignal,
  });
  if (opened.status !== 'presented')
    throwStructureError(
      'DOCUMENT_OPEN_FAILED',
      'message' in opened ? opened.message : 'The molecular document did not open.'
    );
  const tab = useCanvasStore
    .getState()
    .panels[opened.panelId]?.tabs.find((candidate) => candidate.id === opened.tabId);
  return {
    ok: true,
    tabId: opened.tabId,
    structureViewId: tab?.entityId,
    documentReference: reference,
    viewerStatus: 'loading' as const,
  };
}

export function molecularDocumentReferenceLinks(
  reference: MolecularDocumentReference,
  revisionId: string,
  snapshot: MolecularView
) {
  const targets = molecularViewReferenceTargets(revisionId, snapshot);
  return {
    activeViewReference: {
      ...reference,
      viewId: targets[snapshot.initialSnapshotIndex ?? 0]?.selection.viewId,
    },
    inlineLink: molecularDocumentReferenceHref(reference),
    referenceTargets: targets.map((target) => {
      const documentReference = { ...reference, viewId: target.selection.viewId };
      return {
        label: target.label,
        documentReference,
        inlineLink: molecularDocumentReferenceHref(documentReference),
        namedSelections: target.namedSelections.map((group) => {
          const selected = { ...documentReference, groupId: group.selection.groupId };
          return {
            label: group.label,
            documentReference: selected,
            inlineLink: molecularDocumentReferenceHref(selected),
          };
        }),
      };
    }),
  };
}
