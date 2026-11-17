import { TABLE_REFERENCE_NOTEBOOK_BLOCK } from '../shared/table-reference-notebook-contract';
import type { JSONContent } from '@tiptap/core';

import { TABLE_NOTEBOOK_BLOCK } from '../shared/table-notebook-contract';
import { markdownLabel } from '../shared/notebook-reference';
import {
  createNotebookContentExtensionRegistry,
  isUnknownRecord,
  type ResolvedNotebookRichBlock,
} from '../shared/notebook-content-extension';

function linkMarkToMarkdown(text: string, attrs: Readonly<Record<string, unknown>>): string {
  if (typeof attrs.href !== 'string' || attrs.href.length === 0) return text;

  let destination: string;
  try {
    destination = encodeURI(attrs.href).replace(/%25([0-9a-f]{2})/gi, '%$1');
  } catch {
    return text;
  }

  const title =
    typeof attrs.title === 'string' && attrs.title.length > 0
      ? ` "${attrs.title
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/[\r\n]+/g, ' ')}"`
      : '';
  return `[${text}](<${destination}>${title})`;
}

export const notebookContentExtensions = createNotebookContentExtensionRegistry([
  TABLE_NOTEBOOK_BLOCK,
  TABLE_REFERENCE_NOTEBOOK_BLOCK,
  {
    kind: 'rich-block',
    type: 'image',
    currentVersion: 1,
    migrations: [],
    markdownNodeTypes: ['image'],
    parseData: (value) =>
      isUnknownRecord(value) &&
      ['src', 'alt', 'caption', 'fileName', 'source', 'mediaType', 'notebookPackagePath'].every(
        (key) => value[key] === undefined || typeof value[key] === 'string'
      )
        ? { ok: true, data: value }
        : { ok: false, reason: 'image attributes must be an object with string source and labels' },
    toMarkdown: ({ data }) => {
      const source = typeof data.src === 'string' ? data.src : '';
      const label =
        typeof data.alt === 'string'
          ? data.alt
          : typeof data.fileName === 'string'
            ? data.fileName
            : 'Image';
      return `![${markdownLabel(label)}](<${source.replace(/>/g, '%3E').replace(/</g, '%3C').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}>)`;
    },
    fromMarkdown: ({ refId, node }) =>
      typeof node.url === 'string'
        ? {
            refId,
            data: {
              src: node.url,
              alt: node.alt ?? '',
              source: 'url',
              ...(node.title ? { caption: node.title } : {}),
            },
          }
        : null,
  },
  {
    kind: 'mark',
    type: 'link',
    toMarkdown: ({ text, attrs }) => linkMarkToMarkdown(text, attrs),
  },
  {
    kind: 'mark',
    type: 'underline',
    toMarkdown: ({ text }) => `<u>${text}</u>`,
  },
]);

export interface NotebookRichBlockExtensionDescriptor {
  readonly kind: 'rich-block';
  readonly type: string;
  readonly version: number;
}

export interface NotebookRichBlockNodeResolution {
  readonly node: JSONContent;
  readonly refId: string;
  readonly resolved: ResolvedNotebookRichBlock;
  readonly descriptor: NotebookRichBlockExtensionDescriptor;
}

export function resolveNotebookRichBlockNode(
  node: JSONContent
): NotebookRichBlockNodeResolution | null {
  if (node.type !== 'embed') return null;
  const attrs = node.attrs;
  if (!isUnknownRecord(attrs) || typeof attrs.refId !== 'string' || !attrs.refId) {
    throw new Error('Notebook rich block must carry a non-empty refId');
  }
  const resolved = notebookContentExtensions.resolveRichBlock({
    type: attrs.type,
    version: attrs.version,
    data: attrs.data ?? {},
  });
  const descriptor = {
    kind: 'rich-block',
    type: resolved.kind === 'supported' ? resolved.contract.type : resolved.type,
    version: resolved.version,
  } satisfies NotebookRichBlockExtensionDescriptor;
  const normalizedNode =
    resolved.kind === 'supported' && resolved.sourceVersion !== resolved.version
      ? {
          ...node,
          attrs: { ...attrs, version: resolved.version, data: resolved.data },
        }
      : node;
  return { node: normalizedNode, refId: attrs.refId, resolved, descriptor };
}

export function notebookRichBlockMarkdown(node: unknown): string | null {
  if (!isUnknownRecord(node) || typeof node.type !== 'string') return null;
  const attrs = isUnknownRecord(node.attrs) ? node.attrs : undefined;
  const resolution = resolveNotebookRichBlockNode({ type: node.type, attrs });
  if (!resolution) return null;
  return notebookRichBlockMarkdownFromResolution(resolution);
}

export function notebookRichBlockMarkdownFromResolution(
  resolution: NotebookRichBlockNodeResolution
): string {
  switch (resolution.resolved.kind) {
    case 'supported':
      return resolution.resolved.contract.toMarkdown({
        refId: resolution.refId,
        data: resolution.resolved.data,
      });
    case 'unknown':
      return `> DNAForge ${resolution.resolved.type} block (version ${resolution.resolved.version}). Open in a compatible DNAForge version to edit it.`;
    case 'future':
      return `> DNAForge ${resolution.resolved.type} block (version ${resolution.resolved.version}; this app supports ${resolution.resolved.supportedVersion}). Open in a newer DNAForge version to edit it.`;
    default: {
      const exhaustive: never = resolution.resolved;
      return exhaustive;
    }
  }
}
