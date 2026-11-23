import { readNotebookElementAttribute } from './notebook-element-attributes';
import { Mention } from '@tiptap/extension-mention';
import { mergeAttributes } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { notebookReferenceClipboardPlugin } from './notebook-reference-clipboard';
export const NotebookMentionNode = Mention.extend({
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), notebookReferenceClipboardPlugin()];
  },
  addAttributes() {
    return {
      occurrenceId: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-occurrence-id'),
        renderHTML: (attributes) =>
          attributes.occurrenceId ? { 'data-occurrence-id': attributes.occurrenceId } : {},
      },
      representationId: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-representation-id'),
        renderHTML: (attributes) =>
          attributes.representationId
            ? { 'data-representation-id': attributes.representationId }
            : {},
      },
      versionId: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-version-id'),
        renderHTML: (attributes) =>
          attributes.versionId ? { 'data-version-id': attributes.versionId } : {},
      },
      resourceReference: {
        default: null,
        parseHTML: (element) => {
          const value = readNotebookElementAttribute(element, 'data-resource-reference');
          if (!value) return null;
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        },
        renderHTML: (attributes) =>
          attributes.resourceReference
            ? { 'data-resource-reference': JSON.stringify(attributes.resourceReference) }
            : {},
      },
      referenceUri: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-reference-uri'),
        renderHTML: (attributes) =>
          attributes.referenceUri ? { 'data-reference-uri': attributes.referenceUri } : {},
      },
      id: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-id'),
        renderHTML: (attributes) => {
          if (!attributes.id) return {};
          return { 'data-id': attributes.id };
        },
      },
      label: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-label'),
        renderHTML: (attributes) => {
          if (!attributes.label) return {};
          return { 'data-label': attributes.label };
        },
      },
      entityType: {
        default: 'page',
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-entity-type'),
        renderHTML: (attributes) => {
          return { 'data-entity-type': attributes.entityType };
        },
      },
      entityId: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-entity-id'),
        renderHTML: (attributes) => {
          if (!attributes.entityId) return {};
          return { 'data-entity-id': attributes.entityId };
        },
      },
      path: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-path'),
        renderHTML: (attributes) => {
          if (!attributes.path) return {};
          return { 'data-path': attributes.path };
        },
      },
      contentHash: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-content-hash'),
        renderHTML: (attributes) => {
          if (!attributes.contentHash) return {};
          return { 'data-content-hash': attributes.contentHash };
        },
      },
      objectUuid: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-object-uuid'),
        renderHTML: (attributes) => {
          if (!attributes.objectUuid) return {};
          return { 'data-object-uuid': attributes.objectUuid };
        },
      },
      registryKind: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-registry-kind'),
        renderHTML: (attributes) => {
          if (!attributes.registryKind) return {};
          return { 'data-registry-kind': attributes.registryKind };
        },
      },
      projectId: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-project-id'),
        renderHTML: (attributes) => {
          if (!attributes.projectId) return {};
          return { 'data-project-id': attributes.projectId };
        },
      },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': this.name }, this.options.HTMLAttributes, HTMLAttributes),
      node.attrs.label ?? '',
    ];
  },
  renderText({ node }: { node: ProseMirrorNode }) {
    return node.attrs.label ?? '';
  },
});
