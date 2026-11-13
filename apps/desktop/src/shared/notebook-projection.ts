import type { JSONContent } from '@tiptap/core';
import { contentFingerprint } from './content-fingerprint';

export function notebookProjectionFingerprint(title: string, content: unknown): string {
  return contentFingerprint(
    `${title}\u0000${typeof content === 'string' ? content : JSON.stringify(content)}`
  );
}

export interface NotebookPageRow {
  id: string;
  title: string;
  content: string;
  date: number | null;
  created_at: number;
  updated_at: number;
}

export interface NotebookProjectionFromFileInput {
  pageId: string;
  workspaceRoot: string | null;
  sourcePath: string;
  sourceFingerprint: string;
  expectedProjectionFingerprint: string | null;
}

export type LegacyNotebookPageMutation =
  | { operation: 'delete'; id: string }
  | {
      operation: 'create' | 'upsert';
      id: string;
      title: string;
      content: JSONContent;
      updatedAt: number;
      expectedProjectionFingerprint: string | null;
    };
