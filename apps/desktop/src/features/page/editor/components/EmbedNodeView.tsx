'use client';

import { memo, useCallback, useRef } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { embedRegistry } from '../../embeds/registry';
import { GenericEmbedRenderer } from './GenericEmbedRenderer';
import {
  openTableNotebookView,
  updateTableNotebookAttributes,
} from '../../embeds/table/notebook-observation';
import type { TableOperationObservation } from '../../../../shared/table-notebook-observation';

type EmbedRendererComponent = ReturnType<typeof embedRegistry.getRenderer>;

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

interface MemoEmbedRendererProps {
  Renderer: EmbedRendererComponent;
  type: string;
  storedVersion?: number;
  supportedVersion?: number;
  refId: string;
  data: Record<string, unknown>;
  selected: boolean;
  onUpdateAttrs: (
    newAttrs: Record<string, unknown>,
    observation?: TableOperationObservation
  ) => void;
  onOpenTable?: (open: () => boolean) => void;
  onSelect: () => void;
  onBlurToEditor: () => void;
  onExpand: () => void;
  onRemove: () => void;
}

function MemoEmbedRendererImpl({
  Renderer,
  type,
  storedVersion,
  supportedVersion,
  refId,
  data,
  selected,
  onUpdateAttrs,
  onOpenTable,
  onSelect,
  onBlurToEditor,
  onExpand,
  onRemove,
}: MemoEmbedRendererProps) {
  if (!Renderer) {
    return (
      <GenericEmbedRenderer
        type={type}
        storedVersion={storedVersion}
        supportedVersion={supportedVersion}
        refId={refId}
        attrs={data}
        selected={selected}
        onRemove={onRemove}
      />
    );
  }
  return (
    <Renderer
      type={type}
      refId={refId}
      attrs={data}
      selected={selected}
      documentManaged
      onRemove={onRemove}
      onUpdateAttrs={onUpdateAttrs}
      onOpenTable={onOpenTable}
      onSelect={onSelect}
      onBlurToEditor={onBlurToEditor}
      onExpand={onExpand}
    />
  );
}

export const MemoEmbedRenderer = memo(MemoEmbedRendererImpl, (prev, next) => {
  if (prev.Renderer !== next.Renderer) return false;
  if (prev.type !== next.type) return false;
  if (prev.storedVersion !== next.storedVersion) return false;
  if (prev.supportedVersion !== next.supportedVersion) return false;
  if (prev.refId !== next.refId) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.data === next.data) return true;
  return deepEqual(prev.data, next.data);
});

export function EmbedNodeView({
  node,
  selected,
  deleteNode,
  updateAttributes,
  editor,
  getPos,
}: NodeViewProps) {
  const { type, version, refId, data } = node.attrs as {
    type: string;
    version: number;
    refId: string;
    data: Record<string, unknown>;
  };

  const dataRef = useRef(data);
  dataRef.current = data;
  const identityRef = useRef({ type, refId });
  identityRef.current = { type, refId };
  const updateAttributesRef = useRef(updateAttributes);
  updateAttributesRef.current = updateAttributes;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const getPosRef = useRef(getPos);
  getPosRef.current = getPos;
  const deleteNodeRef = useRef(deleteNode);
  deleteNodeRef.current = deleteNode;

  const handleUpdateAttrs = useCallback(
    (newAttrs: Record<string, unknown>, observation?: TableOperationObservation) => {
      if (identityRef.current.type === 'table') {
        const owner = editorRef.current;
        const position = getPosRef.current?.();
        if (!owner || typeof position !== 'number') {
          throw new Error('The table source is no longer mounted.');
        }
        updateTableNotebookAttributes(
          owner,
          position,
          identityRef.current.refId,
          newAttrs,
          observation
        );
        return;
      }
      updateAttributesRef.current({ data: { ...dataRef.current, ...newAttrs } });
    },
    []
  );

  const handleOpenTable = useCallback((open: () => boolean) => {
    let target: { owner: typeof editorRef.current; position: number; refId: string } | null = null;
    try {
      const position = getPosRef.current?.();
      if (identityRef.current.type === 'table' && typeof position === 'number') {
        target = { owner: editorRef.current, position, refId: identityRef.current.refId };
      }
    } catch (_error) {
      void _error;
    }
    if (target) openTableNotebookView(target.owner, target.position, target.refId, open);
    else open();
  }, []);

  const handleSelect = useCallback(() => {
    const ed = editorRef.current;
    const gp = getPosRef.current;
    if (!ed || typeof gp !== 'function') return;
    const pos = gp();
    if (pos === undefined) return;
    const { tr } = ed.state;
    const selection = NodeSelection.create(ed.state.doc, pos);
    ed.view.dispatch(tr.setSelection(selection));
  }, []);

  const handleBlurToEditor = useCallback(() => {
    editorRef.current?.commands.focus();
  }, []);

  const handleExpand = useCallback(() => {
    console.log(`[EmbedNodeView] Expand ${type}:${refId}`);
  }, [type, refId]);

  const handleRemove = useCallback(() => {
    deleteNodeRef.current();
  }, []);

  const Renderer = embedRegistry.getRenderer(type, version);
  const supportedVersion = embedRegistry.get(type)?.version;

  return (
    <NodeViewWrapper>
      <MemoEmbedRenderer
        Renderer={Renderer}
        type={type}
        storedVersion={version}
        supportedVersion={supportedVersion}
        refId={refId}
        data={data}
        selected={selected}
        onUpdateAttrs={handleUpdateAttrs}
        onOpenTable={handleOpenTable}
        onSelect={handleSelect}
        onBlurToEditor={handleBlurToEditor}
        onExpand={handleExpand}
        onRemove={handleRemove}
      />
    </NodeViewWrapper>
  );
}
