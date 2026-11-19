import { Fragment, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import { SavedReferenceChipContent } from '../../../editor/components/SavedReferenceChipContent';

export function TableCellContent({
  content,
  sourceNotebookPageId,
}: {
  content: readonly JSONContent[];
  sourceNotebookPageId?: string;
}) {
  return content.map((node, index) => {
    let rendered: ReactNode = node.type === 'hardBreak' ? <br /> : (node.text ?? '');
    if (node.type === 'mention') {
      rendered = (
        <span
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <SavedReferenceChipContent
            href={node.attrs?.referenceUri ?? ''}
            label={node.attrs?.label ?? ''}
            sourceNotebookPageId={sourceNotebookPageId}
          />
        </span>
      );
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') rendered = <strong>{rendered}</strong>;
      if (mark.type === 'italic') rendered = <em>{rendered}</em>;
    }
    return <Fragment key={index}>{rendered}</Fragment>;
  });
}
