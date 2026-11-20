import type { JSONContent } from '@tiptap/core';
import { isUnknownRecord } from './notebook-content-extension';
import { savedReferenceIdFromHref } from './saved-reference-url';
import { molecularDocumentReferenceFromHref } from './molecular-document-reference';

export function isTableCellContent(value: unknown): value is JSONContent[] {
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every((node) => {
      if (!isUnknownRecord(node)) return false;
      if (
        node.marks !== undefined &&
        (!Array.isArray(node.marks) ||
          !node.marks.every(
            (mark) => isUnknownRecord(mark) && (mark.type === 'bold' || mark.type === 'italic')
          ))
      )
        return false;
      if (node.type === 'text') return typeof node.text === 'string';
      if (node.type === 'hardBreak') return true;
      return (
        node.type === 'mention' &&
        isUnknownRecord(node.attrs) &&
        node.attrs.entityType === 'reference' &&
        typeof node.attrs.label === 'string' &&
        typeof node.attrs.referenceUri === 'string' &&
        Boolean(
          savedReferenceIdFromHref(node.attrs.referenceUri) ||
          molecularDocumentReferenceFromHref(node.attrs.referenceUri)
        )
      );
    })
  );
}

export function tableCellContentText(content: readonly JSONContent[]): string {
  return content
    .map((node) =>
      node.type === 'hardBreak'
        ? '\n'
        : node.type === 'mention'
          ? (node.attrs?.label ?? '')
          : (node.text ?? '')
    )
    .join('');
}
