export interface NativeDocumentWorkspaceRootsRequest {
  readonly loadId: string;
  readonly readableRoots?: readonly string[];
  readonly roots: readonly string[];
}
