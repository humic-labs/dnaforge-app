import { platform } from '../../platform';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  isTypedDocumentCandidate,
  type DocumentAvailability,
  type DocumentAvailabilityRequest,
  type LiteralDocumentKind,
} from '../../shared/document-availability';
import {
  blockedDocument,
  DocumentReadError,
  documentReadError,
} from '../../shared/document-read-failure';
import type { LiteralOpenSnapshot } from './literal-open-snapshot';

const unchecked = { state: 'unchecked' } as const;

async function inspectAvailability(
  request: DocumentAvailabilityRequest,
  retainContents = false
): Promise<{ availability: DocumentAvailability; snapshot?: LiteralOpenSnapshot }> {
  if (!request.package && !request.literalKind && !isTypedDocumentCandidate(request.path))
    return { availability: unchecked };
  const workspace = platform().workspace;
  if (!workspace?.checkDocument) return { availability: unchecked };
  try {
    const check = () => workspace.checkDocument!(request);
    const initial = await check();
    if (initial.state === 'inspect-design-draft') {
      const { checkDesignDraftRecovery } =
        await import('../design/public/check-design-draft-recovery');
      try {
        const draft = checkDesignDraftRecovery(initial.designId);
        const current = await check();
        if (current.state === 'blocked') return { availability: current };
        if (
          current.state !== 'inspect-design-draft' ||
          current.revision !== initial.revision ||
          current.designId !== initial.designId ||
          checkDesignDraftRecovery(current.designId) !== draft
        )
          throw new DocumentReadError('changed', true);
        return {
          availability: {
            state: 'ready',
            kind: 'design',
            revision: `${initial.revision}:${draft}`,
            paths: initial.paths,
          },
        };
      } catch (error) {
        return { availability: blockedDocument(error, initial.paths) };
      }
    }
    if (initial.state !== 'inspect') return { availability: initial };
    const { readLiteralDocument, inspectLiteralDocument } =
      await import('./literal-document-open-check');
    let snapshot: LiteralOpenSnapshot | undefined;
    let failure: DocumentReadError | undefined;
    try {
      if (retainContents) snapshot = await readLiteralDocument(initial.kind, initial.path);
      else await inspectLiteralDocument(initial.kind, initial.path);
    } catch (error) {
      failure = documentReadError(error);
    }
    const current = await check();
    if (current.state === 'blocked') return { availability: current };
    if (current.state !== 'inspect' || current.revision !== initial.revision)
      return { availability: blockedDocument(new DocumentReadError('changed'), initial.paths) };
    if (failure) return { availability: blockedDocument(failure, initial.paths) };
    return {
      availability: {
        state: 'ready',
        kind: initial.kind,
        revision: initial.revision,
        paths: initial.paths,
      },
      snapshot: retainContents ? snapshot : undefined,
    };
  } catch (error) {
    return { availability: blockedDocument(error) };
  }
}

export async function checkDocumentOpen(
  request: DocumentAvailabilityRequest
): Promise<DocumentAvailability> {
  return (await inspectAvailability(request)).availability;
}

function explicitOpenRequest(
  path: string,
  isPackage: boolean,
  literalKind?: LiteralDocumentKind
): DocumentAvailabilityRequest {
  const workspaceRoot =
    findWorkspaceRootForPath(useWorkspaceStore.getState().folders, path) ?? undefined;
  return { workspaceRoot, path, package: isPackage, literalKind };
}

export function checkDocumentBeforeOpen(path: string, isPackage = false) {
  return checkDocumentOpen(explicitOpenRequest(path, isPackage));
}

export function prepareDocumentOpen(
  path: string,
  isPackage: boolean,
  literalKind?: LiteralDocumentKind
) {
  return inspectAvailability(explicitOpenRequest(path, isPackage, literalKind), true);
}
