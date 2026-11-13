import type { JSONContent } from '@tiptap/core';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { contentFingerprint } from '../shared/content-fingerprint';
import { normalizeNotebookReferences } from '../shared/notebook-reference-normalization';
import {
  notebookContentExtensions,
  notebookRichBlockMarkdownFromResolution,
  resolveNotebookRichBlockNode,
  type NotebookRichBlockExtensionDescriptor,
} from './notebook-content-extensions';
import { tipTapContentToMarkdown, type MarkdownReferenceRoots } from './notebook-package';
import { isUnknownRecord } from '../shared/notebook-content-extension';
import type {
  NotebookMarkdownIdentity,
  ParsedNotebookMarkdown,
  PreservedNotebookTitleProjection,
} from '../shared/notebook-package-ipc';

export type {
  NotebookMarkdownIdentity,
  ParsedNotebookMarkdown,
  PreservedNotebookTitleProjection,
} from '../shared/notebook-package-ipc';

export const NOTEBOOK_MARKDOWN_CODEC_VERSION = 1 as const;
export const NOTEBOOK_BLOCK_PAYLOAD_SCHEMA = 'waypoint.notebook.block.v1' as const;
export const NOTEBOOK_BLOCKS_DIR = '.forge/blocks';

export const NOTEBOOK_MARKER_PREFIX = '<!-- dnaforge:notebook ';
const BLOCK_MARKER_PREFIX = '<!-- dnaforge:block ';
const BLOCK_MARKER_END = '<!-- /dnaforge:block -->';
const RAW_MARKER_PREFIX = '<!-- dnaforge:raw ';
const RAW_MARKER_END = '<!-- /dnaforge:raw -->';

export class NotebookMarkdownCodecError extends Error {
  constructor(
    readonly code:
      | 'NOTEBOOK_MARKDOWN_INVALID'
      | 'NOTEBOOK_MARKDOWN_NEWER_CODEC'
      | 'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
    message: string
  ) {
    super(message);
    this.name = 'NotebookMarkdownCodecError';
  }
}

interface NotebookMarkdownMarker extends NotebookMarkdownIdentity {
  codecVersion: number;
}

interface NotebookBlockMarker {
  version: number;
  visibleFingerprint: string;
  payload: string;
}

interface NotebookRawMarker {
  version: number;
  length: number;
}

export interface NotebookBlockPayload {
  schema: typeof NOTEBOOK_BLOCK_PAYLOAD_SCHEMA;
  fingerprint: string;
  node: JSONContent;
  extension?: NotebookRichBlockExtensionDescriptor;
}

export interface SerializedNotebookMarkdown {
  markdown: string;
  payloads: Array<{ relativePath: string; content: string }>;
}

export function notebookPayloadPathsFromMarkdown(markdown: string): string[] {
  const found = new Set<string>();
  const pattern = /<!-- dnaforge:block (\{[^\n]*\}) -->/g;
  for (const match of markdown.matchAll(pattern)) {
    try {
      const marker = JSON.parse(match[1]) as Partial<NotebookBlockMarker>;
      if (
        typeof marker.payload === 'string' &&
        /^\.forge\/blocks\/[a-f0-9]{16}\.json$/.test(marker.payload)
      ) {
        found.add(marker.payload);
      }
    } catch {}
  }
  return [...found].sort();
}

interface MdastPosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface MdastNode {
  type?: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  alt?: string;
  title?: string | null;
  align?: Array<'left' | 'right' | 'center' | null>;
  children?: MdastNode[];
  position?: MdastPosition;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])])
  );
}

export function canonicalNotebookJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function payloadForNode(node: JSONContent): {
  relativePath: string;
  content: string;
  node: JSONContent;
  visibleMarkdown: string | null;
} {
  let richBlock: ReturnType<typeof resolveNotebookRichBlockNode>;
  try {
    richBlock = resolveNotebookRichBlockNode(node);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      `Notebook rich block failed validation: ${message}`
    );
  }
  const normalizedNode = richBlock?.node ?? normalizeNotebookReferences(node);
  const nodeJson = canonicalNotebookJson(normalizedNode);
  const fingerprint = contentFingerprint(nodeJson);
  const payload: NotebookBlockPayload = {
    schema: NOTEBOOK_BLOCK_PAYLOAD_SCHEMA,
    fingerprint,
    node: normalizedNode,
    ...(richBlock ? { extension: richBlock.descriptor } : {}),
  };
  return {
    relativePath: `${NOTEBOOK_BLOCKS_DIR}/${fingerprint}.json`,
    content: `${JSON.stringify(payload, null, 2)}\n`,
    node: normalizedNode,
    visibleMarkdown: richBlock ? `${notebookRichBlockMarkdownFromResolution(richBlock)}\n` : null,
  };
}

function markerLine(prefix: string, value: unknown): string {
  return `${prefix}${canonicalNotebookJson(value)} -->`;
}

function rawMarkdownSource(node: JSONContent): string | null {
  if (node.type !== 'rawMarkdown') return null;
  return typeof node.attrs?.source === 'string' ? node.attrs.source : '';
}

export function serializeNotebookMarkdown(input: {
  identity: NotebookMarkdownIdentity;
  content: JSONContent;
  roots?: MarkdownReferenceRoots;
  preservedPreamble?: string;
  preservedTitleProjection?: PreservedNotebookTitleProjection;
}): SerializedNotebookMarkdown {
  const payloadByPath = new Map<string, string>();
  const preamble = input.preservedPreamble ?? '';
  let markdown = preamble;
  if (markdown && !markdown.endsWith('\n')) markdown += '\n';
  markdown += serializeTitleProjection(input.identity.title, input.preservedTitleProjection);
  markdown += `${markerLine(NOTEBOOK_MARKER_PREFIX, {
    codecVersion: NOTEBOOK_MARKDOWN_CODEC_VERSION,
    formatVersion: input.identity.formatVersion,
    id: input.identity.id,
    title: input.identity.title,
  } satisfies NotebookMarkdownMarker)}\n`;

  const nodes = Array.isArray(input.content.content) ? input.content.content : [];
  for (const node of nodes) {
    const raw = rawMarkdownSource(node);
    if (raw !== null) {
      markdown += `\n${markerLine(RAW_MARKER_PREFIX, {
        version: NOTEBOOK_MARKDOWN_CODEC_VERSION,
        length: raw.length,
      } satisfies NotebookRawMarker)}\n${raw}${RAW_MARKER_END}\n`;
      continue;
    }

    const payload = payloadForNode(node);
    const existingPayload = payloadByPath.get(payload.relativePath);
    if (existingPayload !== undefined && existingPayload !== payload.content) {
      throw new NotebookMarkdownCodecError(
        'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
        `Notebook block fingerprint collision at ${payload.relativePath}`
      );
    }
    payloadByPath.set(payload.relativePath, payload.content);
    const visible =
      payload.visibleMarkdown ??
      tipTapContentToMarkdown({ type: 'doc', content: [payload.node] }, undefined, input.roots);
    const blockMarker: NotebookBlockMarker = {
      version: NOTEBOOK_MARKDOWN_CODEC_VERSION,
      visibleFingerprint: contentFingerprint(visible),
      payload: payload.relativePath,
    };
    markdown += `\n${markerLine(BLOCK_MARKER_PREFIX, blockMarker)}\n${visible}${BLOCK_MARKER_END}\n`;
  }

  return {
    markdown: markdown.endsWith('\n') ? markdown : `${markdown}\n`,
    payloads: [...payloadByPath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content]) => ({ relativePath, content })),
  };
}

function escapeHeading(title: string): string {
  return title.replace(/\\/g, '\\\\').replace(/#/g, '\\#').trim() || 'Untitled';
}

function serializeTitleProjection(
  title: string,
  preserved: PreservedNotebookTitleProjection | undefined
): string {
  if (!preserved) return `# ${escapeHeading(title)}\n\n`;
  if (preserved.kind === 'heading') {
    return `${preserved.beforeHeading}# ${escapeHeading(title)}${preserved.lineEnding}${preserved.afterHeading}`;
  }
  const boundary =
    preserved.source.length > 0 && !preserved.source.endsWith('\n') ? preserved.lineEnding : '';
  return `${preserved.source}${boundary}# ${escapeHeading(title)}${preserved.lineEnding}${preserved.lineEnding}`;
}

function extractPreamble(
  markdown: string,
  allowHorizontalRule = false
): { preamble: string; rest: string; offset: number } {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) {
    return { preamble: '', rest: markdown, offset: 0 };
  }
  const match = /^(---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*\r?\n)/.exec(markdown);
  if (!match) {
    if (allowHorizontalRule) return { preamble: '', rest: markdown, offset: 0 };
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_INVALID',
      'Notebook frontmatter is not terminated'
    );
  }
  return { preamble: match[1], rest: markdown.slice(match[1].length), offset: match[1].length };
}

export function notebookMarkdownPreamble(markdown: string): string {
  return extractPreamble(markdown).preamble;
}

function parseCommentJson<T>(line: string, prefix: string, label: string): T {
  if (!line.startsWith(prefix) || !line.endsWith(' -->')) {
    throw new NotebookMarkdownCodecError('NOTEBOOK_MARKDOWN_INVALID', `Invalid ${label} marker`);
  }
  try {
    return JSON.parse(line.slice(prefix.length, -4)) as T;
  } catch {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_INVALID',
      `Invalid ${label} marker JSON`
    );
  }
}

function readPayload(
  marker: NotebookBlockMarker,
  payloads: ReadonlyMap<string, string>
): JSONContent {
  if (
    marker.version !== NOTEBOOK_MARKDOWN_CODEC_VERSION ||
    typeof marker.visibleFingerprint !== 'string' ||
    typeof marker.payload !== 'string' ||
    !/^\.forge\/blocks\/[a-f0-9]{16}\.json$/.test(marker.payload)
  ) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      'Notebook block marker is invalid'
    );
  }
  const raw = payloads.get(marker.payload);
  if (raw === undefined) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      `Notebook block payload is missing: ${marker.payload}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      `Notebook block payload is malformed: ${marker.payload}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      `Notebook block payload is not an object: ${marker.payload}`
    );
  }
  const payload = parsed as Partial<NotebookBlockPayload>;
  if (
    payload.schema !== NOTEBOOK_BLOCK_PAYLOAD_SCHEMA ||
    typeof payload.fingerprint !== 'string' ||
    !payload.node ||
    typeof payload.node !== 'object' ||
    contentFingerprint(canonicalNotebookJson(payload.node)) !== payload.fingerprint ||
    marker.payload !== `${NOTEBOOK_BLOCKS_DIR}/${payload.fingerprint}.json`
  ) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      `Notebook block payload failed validation: ${marker.payload}`
    );
  }
  let richBlock: ReturnType<typeof resolveNotebookRichBlockNode>;
  try {
    richBlock = resolveNotebookRichBlockNode(payload.node);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      `Notebook block payload extension failed validation: ${message}`
    );
  }
  if (payload.extension !== undefined) {
    if (
      !isUnknownRecord(payload.extension) ||
      payload.extension.kind !== 'rich-block' ||
      typeof payload.extension.type !== 'string' ||
      typeof payload.extension.version !== 'number' ||
      !Number.isSafeInteger(payload.extension.version) ||
      payload.extension.version < 1 ||
      !richBlock ||
      payload.extension.type !== richBlock.descriptor.type ||
      payload.extension.version !== richBlock.descriptor.version
    ) {
      throw new NotebookMarkdownCodecError(
        'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
        `Notebook block payload extension descriptor is invalid: ${marker.payload}`
      );
    }
  }
  return richBlock?.node ?? payload.node;
}

function sourceSlice(source: string, node: MdastNode): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' ? source.slice(start, end) : source;
}

function rawNode(source: string): JSONContent {
  return { type: 'rawMarkdown', attrs: { source } };
}

function inlineNodes(
  children: MdastNode[] | undefined,
  marks: JSONContent['marks'] = []
): JSONContent[] | null {
  const output: JSONContent[] = [];
  for (const node of children ?? []) {
    switch (node.type) {
      case 'text':
        output.push({
          type: 'text',
          text: node.value ?? '',
          marks: marks.length ? marks : undefined,
        });
        break;
      case 'strong': {
        const nested = inlineNodes(node.children, [...marks, { type: 'bold' }]);
        if (!nested) return null;
        output.push(...nested);
        break;
      }
      case 'emphasis': {
        const nested = inlineNodes(node.children, [...marks, { type: 'italic' }]);
        if (!nested) return null;
        output.push(...nested);
        break;
      }
      case 'delete': {
        const nested = inlineNodes(node.children, [...marks, { type: 'strike' }]);
        if (!nested) return null;
        output.push(...nested);
        break;
      }
      case 'inlineCode':
        output.push({
          type: 'text',
          text: node.value ?? '',
          marks: [...marks, { type: 'code' }],
        });
        break;
      case 'link': {
        if (typeof node.url !== 'string') return null;
        const nested = inlineNodes(node.children, [
          ...marks,
          { type: 'link', attrs: { href: node.url, title: node.title ?? null, target: null } },
        ]);
        if (!nested) return null;
        output.push(...nested);
        break;
      }
      case 'break':
        output.push({ type: 'hardBreak' });
        break;
      default:
        return null;
    }
  }
  return output;
}

function blockNode(node: MdastNode, source: string): JSONContent | null {
  if (node.type) {
    const contract = notebookContentExtensions.richBlockForMarkdownNode(node.type);
    if (contract?.fromMarkdown) {
      const sourceSpan = sourceSlice(source, node);
      const converted = contract.fromMarkdown({
        refId: `markdown-${contract.type}-${contentFingerprint(sourceSpan)}`,
        node,
      });
      if (converted) {
        try {
          const resolved = notebookContentExtensions.resolveRichBlock({
            type: contract.type,
            version: contract.currentVersion,
            data: converted.data,
          });
          if (resolved.kind !== 'supported') return null;
          return {
            type: 'embed',
            attrs: {
              type: contract.type,
              version: resolved.version,
              refId: converted.refId,
              data: resolved.data,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new NotebookMarkdownCodecError(
            'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
            `Markdown extension ${contract.type} failed validation: ${message}`
          );
        }
      }
    }
  }
  switch (node.type) {
    case 'paragraph': {
      if (/^\s*:::[A-Za-z]/.test(sourceSlice(source, node)))
        return rawNode(sourceSlice(source, node));
      const content = inlineNodes(node.children);
      return content ? { type: 'paragraph', content } : null;
    }
    case 'heading': {
      const content = inlineNodes(node.children);
      return content
        ? { type: 'heading', attrs: { level: Math.min(6, Math.max(1, node.depth ?? 1)) }, content }
        : null;
    }
    case 'thematicBreak':
      return { type: 'horizontalRule' };
    case 'code':
      if (node.meta) return rawNode(sourceSlice(source, node));
      return {
        type: 'codeBlock',
        attrs: { language: node.lang ?? null },
        content: node.value ? [{ type: 'text', text: node.value }] : [],
      };
    case 'blockquote': {
      const children = blockNodes(node.children ?? [], source);
      return children ? { type: 'blockquote', content: children } : null;
    }
    case 'list': {
      const children: JSONContent[] = [];
      const task = (node.children ?? []).some((child) => typeof child.checked === 'boolean');
      for (const child of node.children ?? []) {
        if (child.type !== 'listItem') return null;
        const itemChildren = blockNodes(child.children ?? [], source);
        if (!itemChildren) return null;
        children.push({
          type: task ? 'taskItem' : 'listItem',
          attrs: task ? { checked: child.checked === true } : undefined,
          content: itemChildren,
        });
      }
      if (task) return { type: 'taskList', content: children };
      return node.ordered
        ? {
            type: 'orderedList',
            attrs: { start: node.start ?? 1, type: null, indent: 0 },
            content: children,
          }
        : { type: 'bulletList', content: children };
    }
    default:
      return null;
  }
}

function blockNodes(nodes: MdastNode[], source: string): JSONContent[] | null {
  const output: JSONContent[] = [];
  for (const node of nodes) {
    const converted = blockNode(node, source);
    if (!converted) return null;
    output.push(converted);
  }
  return output;
}

function parseVisibleMarkdown(source: string): JSONContent[] {
  if (!source.trim()) return [];

  if (/^\s*:::[A-Za-z]/.test(source)) return [rawNode(source.trimEnd())];
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .parse(source) as MdastNode;
  const output: JSONContent[] = [];
  for (const child of tree.children ?? []) {
    if (child.type === 'paragraph' && child.children?.some((node) => node.type === 'image')) {
      let inline: MdastNode[] = [];
      const flush = () => {
        if (!inline.length) return;
        const content = inlineNodes(inline);
        output.push(content ? { type: 'paragraph', content } : rawNode(sourceSlice(source, child)));
        inline = [];
      };
      for (const node of child.children) {
        if (node.type !== 'image') inline.push(node);
        else {
          flush();
          output.push(blockNode(node, source) ?? rawNode(sourceSlice(source, node)));
        }
      }
      flush();
      continue;
    }
    if (child.type === 'list') {
      const items = child.children ?? [];
      const taskItems = items.filter((node) => typeof node.checked === 'boolean');
      if (taskItems.length && taskItems.length !== items.length) {
        let group: MdastNode[] = [];
        const flush = () => {
          if (group.length) {
            const node = { ...child, children: group };
            output.push(blockNode(node, source) ?? rawNode(sourceSlice(source, node)));
          }
          group = [];
        };
        for (const item of items) {
          if (group.length && typeof group[0].checked !== typeof item.checked) flush();
          group.push(item);
        }
        flush();
        continue;
      }
    }
    const converted = blockNode(child, source);
    output.push(converted ?? rawNode(sourceSlice(source, child)));
  }
  return output;
}

function unescapeHeading(title: string): string {
  return title.replace(/\\#/g, '#').replace(/\\\\/g, '\\').trim() || 'Untitled';
}

function parseTitleProjection(source: string): {
  title: string | null;
  preserved: PreservedNotebookTitleProjection;
} {
  const match = /(^|\r?\n)# ([^\r\n]+)(\r?\n|$)/.exec(source);
  if (!match) {
    return {
      title: null,
      preserved: {
        kind: 'missing-heading',
        source,
        lineEnding: source.includes('\r\n') ? '\r\n' : '\n',
      },
    };
  }
  const headingStart = match.index + match[1].length;
  const lineEnding = match[3] === '\r\n' ? '\r\n' : '\n';
  const headingEnd = headingStart + 2 + match[2].length + match[3].length;
  return {
    title: unescapeHeading(match[2]),
    preserved: {
      kind: 'heading',
      beforeHeading: source.slice(0, headingStart),
      afterHeading: source.slice(headingEnd),
      lineEnding,
    },
  };
}

function notebookMarkerIndex(markdown: string): number {
  const tree = unified().use(remarkParse).parse(markdown) as MdastNode;
  const marker = tree.children?.find(
    (node) => node.type === 'html' && node.value?.startsWith(NOTEBOOK_MARKER_PREFIX)
  );
  return marker?.position?.start?.offset ?? -1;
}

export function parsePlainNotebookMarkdown(input: {
  markdown: string;
  id: string;
  title: string;
}): ParsedNotebookMarkdown {
  if (notebookMarkerIndex(input.markdown) >= 0) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_INVALID',
      'Use the complete notebook package for marked Markdown.'
    );
  }
  const { preamble, rest } = extractPreamble(input.markdown, true);
  const heading = /^(?:\r?\n)*# ([^\r\n]+)(?:\r?\n|$)/.exec(rest);
  const title = heading ? unescapeHeading(heading[1]) : input.title;
  const body = heading ? rest.slice(heading[0].length) : rest;
  const content = parseVisibleMarkdown(body);
  return {
    id: input.id,
    title,
    formatVersion: 2,
    content: normalizeNotebookReferences({
      type: 'doc',
      content: content.length ? content : [{ type: 'paragraph' }],
    }),
    preservedPreamble: preamble,
    preservedTitleProjection: {
      kind: 'heading',
      beforeHeading: '',
      afterHeading: '\n',
      lineEnding: rest.includes('\r\n') ? '\r\n' : '\n',
    },
  };
}

export function parseNotebookMarkdown(input: {
  markdown: string;
  payloads?: ReadonlyMap<string, string>;
  expected?: Partial<NotebookMarkdownIdentity>;
}): ParsedNotebookMarkdown {
  const knownPackage = Boolean(
    input.expected?.id &&
    typeof input.expected.title === 'string' &&
    input.expected.formatVersion === 2
  );
  const { preamble, rest } = extractPreamble(input.markdown, knownPackage);
  const markerIndex = notebookMarkerIndex(rest);
  if (markerIndex < 0) {
    if (
      input.expected?.id &&
      typeof input.expected.title === 'string' &&
      input.expected.formatVersion === 2
    ) {
      return parsePlainNotebookMarkdown({
        markdown: input.markdown,
        id: input.expected.id,
        title: input.expected.title ?? 'Untitled',
      });
    }
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_INVALID',
      'Notebook Markdown is missing its DNAForge identity marker'
    );
  }
  const markerEnd = rest.indexOf('\n', markerIndex);
  const markerLineText = rest.slice(markerIndex, markerEnd < 0 ? rest.length : markerEnd).trimEnd();
  const marker = parseCommentJson<NotebookMarkdownMarker>(
    markerLineText,
    NOTEBOOK_MARKER_PREFIX,
    'notebook'
  );
  if (marker.codecVersion > NOTEBOOK_MARKDOWN_CODEC_VERSION) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_NEWER_CODEC',
      `Notebook Markdown codec ${marker.codecVersion} is newer than supported codec ${NOTEBOOK_MARKDOWN_CODEC_VERSION}`
    );
  }
  if (
    marker.codecVersion !== NOTEBOOK_MARKDOWN_CODEC_VERSION ||
    typeof marker.formatVersion !== 'number' ||
    typeof marker.id !== 'string' ||
    !marker.id.trim() ||
    typeof marker.title !== 'string'
  ) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_INVALID',
      'Notebook Markdown identity marker is incomplete'
    );
  }
  if (input.expected?.id && input.expected.id !== marker.id) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_INVALID',
      'Notebook Markdown ID does not match package metadata'
    );
  }
  if (input.expected?.formatVersion && input.expected.formatVersion !== marker.formatVersion) {
    throw new NotebookMarkdownCodecError(
      'NOTEBOOK_MARKDOWN_INVALID',
      'Notebook Markdown format version does not match package metadata'
    );
  }

  const titleProjection = parseTitleProjection(rest.slice(0, markerIndex));
  const title = (titleProjection.title ?? marker.title) || 'Untitled';
  const bodyStart = markerEnd < 0 ? rest.length : markerEnd + 1;
  const body = rest.slice(bodyStart);
  const payloads = input.payloads ?? new Map<string, string>();
  const content: JSONContent[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const blockStart = body.indexOf(BLOCK_MARKER_PREFIX, cursor);
    const rawStart = body.indexOf(RAW_MARKER_PREFIX, cursor);
    const start =
      blockStart < 0 ? rawStart : rawStart < 0 ? blockStart : Math.min(blockStart, rawStart);
    if (start < 0) {
      content.push(...parseVisibleMarkdown(body.slice(cursor)));
      break;
    }
    content.push(...parseVisibleMarkdown(body.slice(cursor, start)));
    const startLineEnd = body.indexOf('\n', start);
    if (startLineEnd < 0) {
      throw new NotebookMarkdownCodecError(
        'NOTEBOOK_MARKDOWN_INVALID',
        'Notebook block marker is not terminated'
      );
    }
    if (start === rawStart) {
      const rawMarker = parseCommentJson<NotebookRawMarker>(
        body.slice(start, startLineEnd).trimEnd(),
        RAW_MARKER_PREFIX,
        'raw Markdown'
      );
      if (
        rawMarker.version !== NOTEBOOK_MARKDOWN_CODEC_VERSION ||
        !Number.isSafeInteger(rawMarker.length) ||
        rawMarker.length < 0
      ) {
        throw new NotebookMarkdownCodecError(
          'NOTEBOOK_MARKDOWN_INVALID',
          'Notebook raw Markdown marker is invalid'
        );
      }
      const sourceStart = startLineEnd + 1;
      const sourceEnd = sourceStart + rawMarker.length;
      if (body.slice(sourceEnd, sourceEnd + RAW_MARKER_END.length) !== RAW_MARKER_END) {
        throw new NotebookMarkdownCodecError(
          'NOTEBOOK_MARKDOWN_INVALID',
          'Notebook raw Markdown block is truncated'
        );
      }
      content.push(rawNode(body.slice(sourceStart, sourceEnd)));
      cursor = sourceEnd + RAW_MARKER_END.length;
      continue;
    }

    const end = body.indexOf(BLOCK_MARKER_END, startLineEnd + 1);
    if (end < 0) {
      throw new NotebookMarkdownCodecError(
        'NOTEBOOK_MARKDOWN_INVALID',
        'Notebook block is missing its closing marker'
      );
    }
    const blockMarker = parseCommentJson<NotebookBlockMarker>(
      body.slice(start, startLineEnd).trimEnd(),
      BLOCK_MARKER_PREFIX,
      'block'
    );
    const visible = body.slice(startLineEnd + 1, end);
    if (contentFingerprint(visible) === blockMarker.visibleFingerprint) {
      content.push(readPayload(blockMarker, payloads));
    } else {
      content.push(...parseVisibleMarkdown(visible));
    }
    cursor = end + BLOCK_MARKER_END.length;
  }

  return {
    id: marker.id,
    title,
    formatVersion: marker.formatVersion,
    content: normalizeNotebookReferences({
      type: 'doc',
      content: content.length ? content : [{ type: 'paragraph' }],
    }),
    preservedPreamble: preamble,
    preservedTitleProjection: titleProjection.preserved,
  };
}
