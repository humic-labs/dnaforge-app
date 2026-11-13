import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { markdownLabel, markdownLinkDestination } from '../shared/notebook-reference';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { isUnknownRecord } from '../shared/notebook-content-extension';
import { savedReferenceHref, savedReferenceIdFromHref } from '../shared/saved-reference-url';
import { nativeEntityReferenceHref } from '../shared/native-entity-reference';
import {
  projectResourceReferenceSchema,
  projectResourceReferenceHref,
} from '../shared/project-resource-reference';
import { normalizeNotebookReferences } from '../shared/notebook-reference-normalization';
import type { JSONContent } from '@tiptap/core';
import type { NotebookPackageMetadata } from '../shared/notebook-package-ipc';
export type { NotebookPackageMetadata } from '../shared/notebook-package-ipc';
import {
  notebookContentExtensions,
  notebookRichBlockMarkdown,
} from './notebook-content-extensions';
import {
  FORGE_PACKAGE_MARKER_DIR,
  forgePackagePaths,
  isForgePackageMemberRelativePath,
  isForgePackageMetaPath,
  type ForgePackageMemberSpec,
} from './forge-package';

export const NOTEBOOK_PACKAGE_MARKER_DIR = FORGE_PACKAGE_MARKER_DIR;
export const NOTEBOOK_PACKAGE_META_NAME = 'notebook.json';
export const NOTEBOOK_PACKAGE_SCHEMA = 'waypoint.notebook.v1' as const;
export const NOTEBOOK_PACKAGE_FORMAT_VERSION = 2 as const;
export const NOTEBOOK_PACKAGE_MARKDOWN_CODEC = 'dnaforge.notebook-markdown.v1' as const;

const NOTEBOOK_MEMBER_SPEC: ForgePackageMemberSpec = {
  metaName: NOTEBOOK_PACKAGE_META_NAME,
  memberDirs: ['assets'],
  stemExtensions: ['.md'],
};

export interface NotebookPackagePaths {
  root: string;
  markdownPath: string;
  metaPath: string;
  metaDir: string;
  assetsDir: string;
  blocksDir: string;
  migrationsDir: string;
  migrationJournalPath: string;
  renameJournalPath: string;
}

export interface NotebookPackageDocument {
  schema: typeof NOTEBOOK_PACKAGE_SCHEMA;
  kind: 'notebook';
  id: string;
  title: string;
  content: unknown;
  updatedAt: string;
  storage: {
    type: 'database';
    table: 'pages';
    id: string;
  };
  [key: string]: unknown;
}

export class NotebookPackageContractError extends Error {
  constructor(
    readonly code:
      | 'NOTEBOOK_PACKAGE_INVALID'
      | 'NOTEBOOK_PACKAGE_NEWER_FORMAT'
      | 'NOTEBOOK_PACKAGE_LEGACY_FORMAT',
    message: string
  ) {
    super(message);
    this.name = 'NotebookPackageContractError';
  }
}

const EMPTY_TIPTAP_DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [] }],
};

const LEGACY_NOTEBOOK_UPDATED_AT = '1970-01-01T00:00:00.000Z';
const TIMEZONE_BEARING_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TIMEZONE_LESS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function notebookPackagePaths(packageRoot: string): NotebookPackagePaths {
  const base = forgePackagePaths(packageRoot, NOTEBOOK_PACKAGE_META_NAME);
  return {
    root: base.root,
    markdownPath: `${base.root}${base.sep}${base.stem}.md`,
    metaDir: base.metaDir,
    metaPath: base.metaPath,
    assetsDir: `${base.root}${base.sep}assets`,
    blocksDir: `${base.metaDir}${base.sep}blocks`,
    migrationsDir: `${base.metaDir}${base.sep}migrations`,
    migrationJournalPath: `${base.metaDir}${base.sep}notebook-migration.json`,
    renameJournalPath: `${base.metaDir}${base.sep}notebook-rename.json`,
  };
}

function portableNotebookId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_INVALID',
      'Notebook package is missing id'
    );
  }
  const rawId = stripWorkspaceScope(value.trim());
  if (!rawId) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_INVALID',
      'Notebook package id is empty after stripping project scope'
    );
  }
  return rawId;
}

export function buildNotebookPackageMetadata(input: {
  id: string;
  title: string;
  updatedAt?: string;
  createdAt?: string;
  markdownFileName: string;
  existing?: Record<string, unknown>;
  migration?: NotebookPackageMetadata['migration'];
}): NotebookPackageMetadata {
  const rawId = portableNotebookId(input.id);
  const existing = input.existing ?? {};

  const { content: _legacyContent, storage: _legacyStorage, ...preserved } = existing;
  return {
    ...preserved,
    schema: NOTEBOOK_PACKAGE_SCHEMA,
    kind: 'notebook',
    formatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
    id: rawId,
    title: input.title.trim() || 'Untitled',
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    authority: {
      type: 'markdown',
      path: input.markdownFileName,
      codec: NOTEBOOK_PACKAGE_MARKDOWN_CODEC,
    },
    payloads: {
      blocksDirectory: 'blocks',
      schema: 'waypoint.notebook.block.v1',
    },
    ...(input.migration ? { migration: input.migration } : {}),
  };
}

export function parseNotebookPackageMetadata(content: string): NotebookPackageMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_INVALID',
      'Invalid notebook package JSON'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_INVALID',
      'Notebook package must be a JSON object'
    );
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schema !== NOTEBOOK_PACKAGE_SCHEMA || doc.kind !== 'notebook') {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_INVALID',
      'Not a waypoint.notebook.v1 package document'
    );
  }
  if (doc.formatVersion === undefined) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_LEGACY_FORMAT',
      'Notebook package requires migration from format version 1'
    );
  }
  if (typeof doc.formatVersion !== 'number' || !Number.isInteger(doc.formatVersion)) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_INVALID',
      'Notebook package formatVersion must be an integer'
    );
  }
  if (doc.formatVersion > NOTEBOOK_PACKAGE_FORMAT_VERSION) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_NEWER_FORMAT',
      `Notebook package format ${doc.formatVersion} is newer than supported format ${NOTEBOOK_PACKAGE_FORMAT_VERSION}`
    );
  }
  if (doc.formatVersion !== NOTEBOOK_PACKAGE_FORMAT_VERSION) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_LEGACY_FORMAT',
      `Notebook package requires migration from format version ${doc.formatVersion}`
    );
  }
  const authority = doc.authority;
  const payloads = doc.payloads;
  if (
    !authority ||
    typeof authority !== 'object' ||
    Array.isArray(authority) ||
    (authority as Record<string, unknown>).type !== 'markdown' ||
    typeof (authority as Record<string, unknown>).path !== 'string' ||
    (authority as Record<string, unknown>).codec !== NOTEBOOK_PACKAGE_MARKDOWN_CODEC ||
    !payloads ||
    typeof payloads !== 'object' ||
    Array.isArray(payloads) ||
    (payloads as Record<string, unknown>).blocksDirectory !== 'blocks' ||
    (payloads as Record<string, unknown>).schema !== 'waypoint.notebook.block.v1'
  ) {
    throw new NotebookPackageContractError(
      'NOTEBOOK_PACKAGE_INVALID',
      'Notebook package Markdown authority metadata is incomplete'
    );
  }
  const rawId = portableNotebookId(doc.id);
  return {
    ...doc,
    schema: NOTEBOOK_PACKAGE_SCHEMA,
    kind: 'notebook',
    formatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
    id: rawId,
    title: typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'Untitled',
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date(0).toISOString(),
    authority: {
      type: 'markdown',
      path: (authority as Record<string, unknown>).path as string,
      codec: NOTEBOOK_PACKAGE_MARKDOWN_CODEC,
    },
    payloads: {
      blocksDirectory: 'blocks',
      schema: 'waypoint.notebook.block.v1',
    },
  };
}

export function serializeNotebookPackageMetadata(doc: NotebookPackageMetadata): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function isNotebookPackageMetaPath(path: string): boolean {
  return isForgePackageMetaPath(path, NOTEBOOK_PACKAGE_META_NAME);
}

export function notebookPackageRootForMetaPath(path: string): string | null {
  return isNotebookPackageMetaPath(path)
    ? path.replace(/[/\\]\.forge[/\\]notebook\.json$/iu, '')
    : null;
}

export function notebookPackageWindowsDrivePathKey(path: string): string | null {
  const slashPath = path.replaceAll('\\', '/');
  // eslint-disable-next-line no-control-regex -- Windows rejects control characters in a path.
  if (!/^[A-Za-z]:\/[^/:*?"<>|\u0000-\u001f]+(?:\/[^/:*?"<>|\u0000-\u001f]+)*$/u.test(slashPath))
    return null;
  return slashPath.split('/').some((segment) => segment.endsWith('.') || segment.endsWith(' '))
    ? null
    : slashPath;
}

export function isNotebookPackageMemberRelativePath(relativePath: string): boolean {
  return isForgePackageMemberRelativePath(relativePath, NOTEBOOK_MEMBER_SPEC);
}

export function buildNotebookPackageDocument(input: {
  id: string;
  title: string;
  content?: unknown;
  updatedAt?: string;
  existing?: Record<string, unknown>;
}): NotebookPackageDocument {
  const updatedAt = input.updatedAt ?? new Date().toISOString();

  const rawId = stripWorkspaceScope(input.id);
  return {
    ...(input.existing ?? {}),
    schema: NOTEBOOK_PACKAGE_SCHEMA,
    kind: 'notebook',
    id: rawId,
    title: input.title,
    storage: {
      type: 'database',
      table: 'pages',
      id: rawId,
    },
    content: normalizeNotebookReferences((input.content ?? EMPTY_TIPTAP_DOC) as JSONContent),
    updatedAt,
  };
}

export function parseNotebookPackageDocument(content: string): NotebookPackageDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid notebook package JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Notebook package must be a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schema !== NOTEBOOK_PACKAGE_SCHEMA || doc.kind !== 'notebook') {
    throw new Error('Not a waypoint.notebook.v1 package document');
  }
  if (typeof doc.id !== 'string' || !doc.id.trim()) {
    throw new Error('Notebook package is missing id');
  }

  const rawId = stripWorkspaceScope(doc.id.trim());
  if (rawId !== doc.id.trim()) {
    console.warn(
      `[notebook-package] stripped inherited workspace scope from embedded id: ${doc.id} → ${rawId}`
    );
  }
  if (!rawId) {
    throw new Error('Notebook package id is empty after stripping project scope');
  }
  return {
    ...doc,
    schema: NOTEBOOK_PACKAGE_SCHEMA,
    kind: 'notebook',
    id: rawId,
    title: typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'Untitled',
    content: normalizeNotebookReferences((doc.content ?? EMPTY_TIPTAP_DOC) as JSONContent),

    updatedAt: normalizeNotebookUpdatedAt(doc.updatedAt),
    storage: {
      type: 'database',
      table: 'pages',
      id: rawId,
    },
  };
}

function normalizeNotebookUpdatedAt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return LEGACY_NOTEBOOK_UPDATED_AT;
  const candidate = value.trim();
  const explicitInstant = TIMEZONE_BEARING_TIMESTAMP.test(candidate)
    ? candidate
    : TIMEZONE_LESS_TIMESTAMP.test(candidate)
      ? `${candidate}Z`
      : null;
  if (!explicitInstant) return LEGACY_NOTEBOOK_UPDATED_AT;
  const updatedAtMs = Date.parse(explicitInstant);
  return Number.isFinite(updatedAtMs)
    ? new Date(updatedAtMs).toISOString()
    : LEGACY_NOTEBOOK_UPDATED_AT;
}

export function serializeNotebookPackageDocument(doc: NotebookPackageDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function tipTapContentToMarkdown(
  content: unknown,
  title?: string,
  roots?: MarkdownReferenceRoots
): string {
  const lines: string[] = [];
  if (title?.trim()) {
    lines.push(`# ${title.trim()}`, '');
  }
  const doc =
    content && typeof content === 'object' && !Array.isArray(content)
      ? (content as { type?: string; content?: unknown[] })
      : null;
  const nodes = Array.isArray(doc?.content) ? doc.content : [];
  for (const node of nodes) {
    lines.push(...nodeToMarkdownLines(node, 0, roots));
  }
  const body = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return `${body}\n`;
}

function nodeToMarkdownLines(
  node: unknown,
  listIndent: number,
  roots?: MarkdownReferenceRoots,
  listItemMarker?: string
): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as {
    type?: string;
    content?: unknown[];
    attrs?: Record<string, unknown>;
    text?: string;
    marks?: Array<{ type?: string; attrs?: unknown }>;
  };

  const extensionMarkdown = notebookRichBlockMarkdown(n);
  if (extensionMarkdown !== null) return [extensionMarkdown, ''];

  switch (n.type) {
    case 'paragraph':
      return [`${inlineText(n.content, roots)}`, ''];
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)));
      return [`${'#'.repeat(level)} ${inlineText(n.content, roots)}`, ''];
    }
    case 'bulletList':
      return (n.content ?? []).flatMap((child) =>
        nodeToMarkdownLines(child, listIndent, roots, '- ')
      );
    case 'orderedList': {
      const start = orderedListStart(n.attrs?.start);
      return (n.content ?? []).flatMap((child, index) =>
        nodeToMarkdownLines(child, listIndent, roots, `${start + index}. `)
      );
    }
    case 'taskList':
      return (n.content ?? []).flatMap((child) => {
        const checked =
          child && typeof child === 'object' && !Array.isArray(child)
            ? (child as { attrs?: Record<string, unknown> }).attrs?.checked === true
            : false;
        return nodeToMarkdownLines(child, listIndent, roots, `- [${checked ? 'x' : ' '}] `);
      });
    case 'listItem':
    case 'taskItem': {
      const fallbackMarker =
        n.type === 'taskItem' ? `- [${n.attrs?.checked === true ? 'x' : ' '}] ` : '- ';
      const marker = listItemMarker ?? fallbackMarker;
      const prefix = `${' '.repeat(listIndent)}${marker}`;
      const inner = (n.content ?? []).flatMap((child) =>
        nodeToMarkdownLines(child, listIndent + marker.length, roots)
      );
      if (inner.length === 0) return [`${prefix}`, ''];
      const [first, ...rest] = inner;
      return [`${prefix}${first.trimStart()}`, ...rest];
    }
    case 'codeBlock': {
      const source = (n.content ?? [])
        .map((child) => (child as { text?: string }).text ?? '')
        .join('');
      const longest = Math.max(
        2,
        ...Array.from(source.matchAll(/`+/g), (match) => match[0].length)
      );
      const fence = '`'.repeat(longest + 1);
      const language =
        typeof n.attrs?.language === 'string' ? n.attrs.language.replace(/[\r\n`]/g, '') : '';
      return [`${fence}${language}`, source, fence, ''];
    }
    case 'blockquote':
      return (n.content ?? [])
        .flatMap((child) => nodeToMarkdownLines(child, listIndent, roots))
        .map((line) => (line ? `> ${line}` : '>'));
    case 'horizontalRule':
      return ['---', ''];
    case 'rawMarkdown':
      return [typeof n.attrs?.source === 'string' ? n.attrs.source : '', ''];
    case 'text':
      return [formatTextNode(n)];
    default:
      if (n.content?.length) {
        return n.content.flatMap((child) => nodeToMarkdownLines(child, listIndent, roots));
      }
      return [`<!-- unsupported:${n.type ?? 'unknown'} -->`, ''];
  }
}

function orderedListStart(value: unknown): number {
  const start = Number(value ?? 1);
  return Number.isSafeInteger(start) && start > 0 ? start : 1;
}

function inlineText(content: unknown[] | undefined, roots?: MarkdownReferenceRoots): string {
  if (!content?.length) return '';
  return content
    .map((child) => {
      if (!child || typeof child !== 'object') return '';
      const n = child as {
        type?: string;
        text?: string;
        content?: unknown[];
        attrs?: Record<string, unknown>;
        marks?: Array<{ type?: string }>;
      };
      if (n.type === 'text') return formatTextNode(n);
      if (n.type === 'hardBreak') return '  \n';

      if (n.type === 'mention') return mentionToMarkdown(n.attrs, roots);
      return inlineText(n.content, roots);
    })
    .join('');
}

export interface MarkdownReferenceRoots {
  workspaceRoot: string;

  packageRoot: string;
}

function referencePathFrom(attrs: Record<string, unknown> | undefined): string | null {
  const explicit = typeof attrs?.path === 'string' && attrs.path ? attrs.path : null;
  if (explicit) return explicit;

  const legacy = typeof attrs?.entityId === 'string' && attrs.entityId ? attrs.entityId : null;
  if (!legacy) return null;
  const looksLikePath = legacy.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(legacy);
  return looksLikePath ? legacy : null;
}

function mentionToMarkdown(
  attrs: Record<string, unknown> | undefined,
  roots?: MarkdownReferenceRoots
): string {
  const label = typeof attrs?.label === 'string' && attrs.label ? attrs.label : 'reference';
  const escapedLabel = markdownLabel(label);

  if (attrs?.entityType === 'project-resource') {
    const target = projectResourceReferenceSchema.safeParse(attrs.resourceReference);
    if (target.success) return `[${escapedLabel}](${projectResourceReferenceHref(target.data)})`;
  }

  const referenceId = savedReferenceIdFromHref(
    typeof attrs?.referenceUri === 'string' ? attrs.referenceUri : null
  );
  if (referenceId) return `[${escapedLabel}](${savedReferenceHref(referenceId)})`;
  if (attrs?.entityType === 'native-catalog' && typeof attrs.entityId === 'string') {
    const href = nativeEntityReferenceHref(attrs.entityId);
    if (href) return `[${escapedLabel}](${href})`;
  }

  const path = referencePathFrom(attrs);

  if (!path || !roots || !isSafeWorkspaceRelativePath(path)) return escapedLabel;

  const destinationPath =
    attrs?.entityType === 'page' ? `${path}/${path.split('/').filter(Boolean).pop()}.md` : path;

  const destination = markdownLinkDestination(
    destinationPath,
    roots.workspaceRoot,
    roots.packageRoot
  );
  return `[${escapedLabel}](${destination})`;
}

function formatTextNode(n: {
  text?: string;
  marks?: Array<{ type?: string; attrs?: unknown }>;
}): string {
  let text = n.text ?? '';
  const marks = new Set((n.marks ?? []).map((m) => m.type).filter(Boolean));
  if (marks.has('code')) text = `\`${text}\``;
  if (marks.has('bold') || marks.has('strong')) text = `**${text}**`;
  if (marks.has('italic') || marks.has('em')) text = `*${text}*`;
  if (marks.has('strike')) text = `~~${text}~~`;

  if (marks.has('highlight')) text = `==${text}==`;

  if (marks.has('subscript')) text = `~${text}~`;
  if (marks.has('superscript')) text = `^${text}^`;
  const builtInMarks = new Set([
    'code',
    'bold',
    'strong',
    'italic',
    'em',
    'strike',
    'highlight',
    'subscript',
    'superscript',
  ]);
  for (const mark of n.marks ?? []) {
    if (!mark.type || builtInMarks.has(mark.type)) continue;
    const extension = notebookContentExtensions.mark(mark.type);
    if (!extension) continue;
    text = extension.toMarkdown({
      text,
      attrs: isUnknownRecord(mark.attrs) ? mark.attrs : {},
    });
  }
  return text;
}

export { EMPTY_TIPTAP_DOC as NOTEBOOK_EMPTY_TIPTAP_DOC };
