export type WorkspaceAppendHierarchyFolder = Readonly<{
  sourceId: string;
  name: string;
  parentSourceId: string;
  archiveRelativePath: string;
}>;

export type WorkspaceAppendHierarchyMembership = Readonly<{
  sourceObjectId: string;
  folderSourceId: string;
}>;

export type WorkspaceAppendHierarchyCapture = Readonly<{
  schema: 'dnaforge.benchling.workspace-append-hierarchy-capture.v1';
  id: string;
  runId: string;
  attemptId: string;
  artifactId: string;
  artifactSha256: `sha256:${string}`;
  destinationRootSourceId: string;
  zipRootName: string;
  folders: readonly WorkspaceAppendHierarchyFolder[];
  memberships: readonly WorkspaceAppendHierarchyMembership[];
  capturedAt: string;
}>;
