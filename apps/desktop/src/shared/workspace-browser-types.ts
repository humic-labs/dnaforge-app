import type { CatalogRecordPresentationKind } from './catalog-entity';

export type NativeCatalogRecordReconcileRequest = Readonly<{
  workspaceRoot: string;
  expectedManifestSha256: string;
  mutationToken?: string;
}>;

export type WorkspaceBrowserFilesystemEntry = Readonly<{
  kind: 'filesystem';
  entryId: string;
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
}>;

export type WorkspaceBrowserCatalogEntry = Readonly<{
  kind: 'catalog';
  entryId: string;
  workspaceId: number;
  entityId: string;
  sourceRecordId: string | null;
  name: string;
  parentRelativePath: string;
  presentationKind: CatalogRecordPresentationKind;
}>;

export type WorkspaceBrowserEntry = WorkspaceBrowserFilesystemEntry | WorkspaceBrowserCatalogEntry;

export type WorkspaceBrowserPartialError = Readonly<{
  source: 'catalog';
  code: 'catalog_listing_failed';
  message: string;
}>;

export type WorkspaceListChildrenRequest = Readonly<{
  workspaceRoot: string;
  parentRelativePath: string;
}>;

export type WorkspaceListChildrenResult = Readonly<{
  workspaceId: number | null;
  parentRelativePath: string;
  entries: WorkspaceBrowserEntry[];
  partialError: WorkspaceBrowserPartialError | null;
}>;
