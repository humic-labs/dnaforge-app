import { ReactNodeViewRenderer } from '@tiptap/react';
import { EmbedNodeView } from '../components/EmbedNodeView';
import { NotebookEmbedNode } from './notebook-embed-model';
export type { EmbedNodeOptions } from './notebook-embed-model';
export const EmbedNode = NotebookEmbedNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(EmbedNodeView);
  },
});
