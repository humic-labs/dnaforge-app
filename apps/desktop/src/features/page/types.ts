import type { JSONContent } from '@tiptap/core';

export interface Page {
  id: string;
  title: string;
  content: JSONContent;
  date: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageListItem {
  id: string;
  title: string;
  date?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageEditorProps {
  pageId: string;
  canvasTabId?: string;
}
