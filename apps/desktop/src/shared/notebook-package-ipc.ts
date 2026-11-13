import type { JSONContent } from '@tiptap/core';

export interface NotebookMarkdownIdentity {
  id: string;
  title: string;
  formatVersion: number;
}

export type PreservedNotebookTitleProjection =
  | {
      kind: 'heading';
      beforeHeading: string;
      afterHeading: string;
      lineEnding: '\n' | '\r\n';
    }
  | {
      kind: 'missing-heading';
      source: string;
      lineEnding: '\n' | '\r\n';
    };

export interface ParsedNotebookMarkdown {
  id: string;
  title: string;
  formatVersion: number;
  content: JSONContent;
  preservedPreamble: string;
  preservedTitleProjection: PreservedNotebookTitleProjection;
}

export interface NotebookPackageMetadata {
  schema: 'waypoint.notebook.v1';
  kind: 'notebook';
  formatVersion: 2;
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  authority: {
    type: 'markdown';
    path: string;
    codec: 'dnaforge.notebook-markdown.v1';
  };
  payloads: {
    blocksDirectory: 'blocks';
    schema: 'waypoint.notebook.block.v1';
  };
  migration?: {
    fromFormatVersion: number;
    completedAt: string;
    archivePath: string;
    sourceShape: string;
  };
  [key: string]: unknown;
}

export type NotebookMigrationSourceShape =
  | 'new-package'
  | 'database-only'
  | 'legacy-wpnote'
  | 'v1-package'
  | 'v2-package'
  | 'restored-package';

export type NotebookMigrationInterruptionPoint =
  | 'after-stage-before-publish'
  | 'after-publish-before-metadata';

export interface PublishNotebookPackageInput {
  packageRoot: string;
  workspaceRoot: string;
  id: string;
  title: string;
  content: JSONContent;
  sourceShape: NotebookMigrationSourceShape;
  existingMetadataRaw?: string | null;
  formerAuthorityRaw?: string | null;
  preservedPreamble?: string;
  preservedTitleProjection?: PreservedNotebookTitleProjection;
  updatedAt?: string;
  now?: () => Date;
  interruptAt?: NotebookMigrationInterruptionPoint;
  expectedCanonicalFingerprint?: string;
  expectedProjectionContent?: JSONContent;
  mutationToken?: string;
}

export type SerializablePublishNotebookPackageInput = Omit<
  PublishNotebookPackageInput,
  'now' | 'interruptAt'
>;

export interface MigrateNotebookPackageAtPathInput {
  packageRoot: string;
  workspaceRoot: string;
  mutationToken?: string;
}

export interface PrepareNotebookPackageRenameInput {
  packageRoot: string;
  nextPackageRoot: string;
  title: string;
  workspaceRoot: string;
  expectedCanonicalFingerprint?: string;
  mutationToken?: string;
  now?: () => Date;
}

export interface RecoverNotebookPackageRenameInput {
  workspaceRoot: string;
  packageRoot: string;
  mutationToken?: string;
}

export interface PublishNotebookPackageResult {
  metadata: NotebookPackageMetadata;
  parsed: ParsedNotebookMarkdown;
  markdownBytes: number;
  canonicalFingerprint: string;
  recovered: boolean;
  changed: boolean;
}
