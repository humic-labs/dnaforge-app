export const LOCAL_INDEXED_TRACK_AUTHORITY_CONTRACT =
  'dnaforge.local-indexed-track-authority.v1' as const;

export type LocalAuthorityContext = 'dev-scenario-fixture' | 'workspace-grounded';

export interface LocalIndexedTrackAuthorityRequest {
  readonly path: string;
  readonly relatedManifestPath?: string;
  readonly devScenarioFixture?: boolean;
  readonly workspaceGrounded?: boolean;
}

export interface LocalIndexedTrackAuthorityReceipt {
  readonly canonicalPath: string;
  readonly authority: string;
}
