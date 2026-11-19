import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  entityPickerNavigation,
  type EntityPickerPage,
} from '../extensions/inline-picker-navigation';
import { createInlinePickerPopup, type InlinePickerPopup } from '../extensions/inline-picker-popup';
import { finishReferenceEdit, isEditingReference } from '../extensions/reference-edit';
import { NotebookPickerMenu } from './NotebookPickerMenu';
import { MentionChip } from './MentionChip';
import type { MentionMenuRef } from './MentionMenu';

function ReferenceDraft({ editor, node, getPos, extension }: NodeViewProps) {
  const [page, setPage] = useState<EntityPickerPage>(() => ({
    kind: 'entity',
    query: node.attrs.label ?? '',
    category: null,
    view: 'home',
    parent: null,
  }));
  const [content] = useState(() => editor.view.dom.ownerDocument.createElement('div'));
  const tab = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<MentionMenuRef>(null);
  const popup = useRef<InlinePickerPopup | null>(null);
  useLayoutEffect(() => {
    if (!tab.current || !input.current) return;
    const instance = createInlinePickerPopup({
      editor,
      content,
      anchor: tab.current,
      onDismiss: () => finishReferenceEdit(editor, getPos(), false),
    });
    popup.current = instance;
    input.current.focus({ preventScroll: true });
    input.current.select();
    return () => {
      popup.current = null;
      instance.destroy();
    };
  }, [editor, content, getPos]);
  useLayoutEffect(() => {
    popup.current?.update();
  }, [page]);

  const navigation = entityPickerNavigation(page, (next) => {
    if (next.kind === 'entity') setPage(next);
  });

  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <span
        ref={tab}
        data-entity-query=""
        data-tab-start=""
        data-tab-end=""
        className="text-accent"
      >
        @
        <input
          ref={input}
          aria-label="Edit reference"
          className="notebook-reference-input"
          value={page.query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setPage({ ...page, query: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.stopPropagation();
            if (event.key === 'Escape' || (event.key === 'Backspace' && !page.query)) {
              event.preventDefault();
              if (event.key === 'Backspace' && navigation.onBack) navigation.onBack();
              else
                finishReferenceEdit(
                  editor,
                  getPos(),
                  true,
                  event.key === 'Backspace' ? 'delete' : undefined
                );
            } else if (event.key === 'Tab') {
              finishReferenceEdit(editor, getPos(), false);
            } else if (
              menu.current?.onKeyDown({ event: event.nativeEvent }) ||
              event.key === 'Enter'
            ) {
              event.preventDefault();
            }
          }}
        />
      </span>
      {createPortal(
        <NotebookPickerMenu
          ref={menu}
          page={{
            kind: 'entity',
            props: {
              ...navigation,
              workspaceRoot: extension.options.referenceWorkspaceRoot?.() ?? null,
              command: (attrs) => finishReferenceEdit(editor, getPos(), true, attrs),
            },
          }}
        />,
        content
      )}
    </NodeViewWrapper>
  );
}

export function ReferenceNodeView(props: NodeViewProps) {
  return isEditingReference(props.decorations) ? (
    <ReferenceDraft {...props} />
  ) : (
    <MentionChip {...props} />
  );
}
