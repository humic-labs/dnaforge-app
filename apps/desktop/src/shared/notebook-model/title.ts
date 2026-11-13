import type { JSONContent } from '@tiptap/core';

const PROVISIONAL_NOTEBOOK_TITLE = /^Untitled(?: [1-9]\d*)?$/u;

export function shouldDeriveNotebookTitleFromContent(
  currentTitle: string | null | undefined
): boolean {
  return typeof currentTitle === 'string' && PROVISIONAL_NOTEBOOK_TITLE.test(currentTitle.trim());
}

export function extractTitle(content: JSONContent): string | null {
  const firstNode = content.content?.[0];
  if (!firstNode) return null;

  if (firstNode.type === 'heading') {
    return firstNode.content?.[0]?.text || null;
  }
  if (firstNode.type === 'paragraph') {
    const text = firstNode.content?.[0]?.text;
    return text ? text.slice(0, 50) : null;
  }
  return null;
}
