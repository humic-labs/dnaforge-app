export type SaveDocumentTarget =
  | { kind: 'page'; pageId: string }
  | { kind: 'sequence-document'; documentId: string }
  | { kind: 'file'; filePath: string }
  | { kind: 'tab'; tabId: string };

export function saveDocumentTargetId(target: SaveDocumentTarget): string {
  switch (target.kind) {
    case 'page':
      return target.pageId;
    case 'sequence-document':
      return target.documentId;
    case 'file':
      return target.filePath;
    case 'tab':
      return target.tabId;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

declare global {
  interface WindowEventMap {
    'document-discarded': CustomEvent<SaveDocumentTarget & { sourceTabId?: string }>;
  }
}
