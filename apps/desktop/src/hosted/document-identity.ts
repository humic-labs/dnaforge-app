import { hostedWorkspaceSessionController } from './controller';
import { parseHostedFsPath } from './paths';

export interface HostedDocumentIdentity {
  workspaceId: string;
  clientWorkspaceId: string;
  revisionId: string;
  revisionNumber: number;
  acceptedBaseRevisionId: string;
  localRevisionId: string | null;
  documentPath: string;
  resourceId: string;
  contentSha256: string;
}

export function hostedDocumentIdentity(absolutePath: string): HostedDocumentIdentity | null {
  const parsed = parseHostedFsPath(absolutePath);
  if (!parsed?.workspaceId || !parsed.relativePath) return null;
  const session = hostedWorkspaceSessionController.getState();
  const workspace = session.workspaces.find(
    (candidate) => candidate.workspaceId === parsed.workspaceId
  );
  const snapshot = session.snapshot;
  if (!workspace?.clientWorkspaceId || !snapshot || snapshot.workspaceId !== parsed.workspaceId)
    return null;
  const file = snapshot.files.find((candidate) => candidate.path === parsed.relativePath);
  if (!file) return null;
  return {
    workspaceId: workspace.workspaceId,
    clientWorkspaceId: workspace.clientWorkspaceId,
    revisionId: snapshot.localRevisionId ? '' : (snapshot.revisionId ?? ''),
    revisionNumber: snapshot.revisionNumber,
    acceptedBaseRevisionId: snapshot.revisionId ?? '',
    localRevisionId: snapshot.localRevisionId ?? null,
    documentPath: file.path,
    resourceId: file.resourceId ?? '',
    contentSha256: file.contentSha256 ?? file.contentRevision?.replace(/^sha256:/u, '') ?? '',
  };
}
