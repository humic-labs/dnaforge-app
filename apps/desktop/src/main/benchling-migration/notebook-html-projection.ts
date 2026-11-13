import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { staticSvgImage } from './static-svg-image';
import type { JSONContent } from '@tiptap/core';
import {
  buildNotebookPackageDocument,
  type NotebookPackageDocument,
} from '../../db/notebook-package';
import type { SourceObject } from '../../shared/benchling-migration';
import { sanitizeBenchlingMigrationExternalHttpUrl } from '../../shared/benchling-migration-external-url';
import { nativeEntityReferenceHref } from '../../shared/native-entity-reference';
import {
  isBenchlingLocalExportProvenanceUrn,
  parseExactlyOneBenchlingObjectUrl,
} from './source-identity';
import { benchlingInternalLinkTargetId } from './native-export-decoder';
import {
  isExactProviderStableId,
  isSafeProviderCanonicalUrl,
  providerObjectClassForStableId,
  providerStableIdFromUrl,
} from '../../shared/provider-object-reference';
import { isSafeWorkspaceRelativePath } from './safe-workspace-path';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const ARTIFACT_TAGS = new Set(['audio', 'canvas', 'embed', 'iframe', 'object', 'svg', 'video']);
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const LOCAL_LINK_URL_LIKE = /^(?:https?:\/\/|\/\/|\/|\.\.?\/)/iu;
const LOCAL_LINK_OBJECT_ID = /\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/gu;
const LOCAL_LINK_OBJECT_PREFIXES = new Set([
  'bfi',
  'efl',
  'ent',
  'entry',
  'etr',
  'fld',
  'lib',
  'oligo',
  'prt',
  'prtn',
  'scrfile',
  'seq',
  'src',
]);
const BENCHLING_LIST_INDENT_PIXELS = 35;
const LITERAL_URL_LIKE = /(?<![A-Za-z0-9_])(?:https?:[\\/]*|[\\/]{2}(?=[^\\/\s<>"']))[^\s<>"']+/giu;
const NON_RENDERED_CONTAINER_TAGS = new Set([
  'head',
  'noscript',
  'script',
  'style',
  'template',
  'textarea',
  'title',
]);

export const NOTEBOOK_HTML_PROJECTION_LIMITS = Object.freeze({
  maximumHtmlBytes: 16 * 1024 * 1024,
  maximumNodes: 256 * 1024,
  maximumDepth: 64,
  maximumTagBytes: 512 * 1024,
  maximumAttributesPerElement: 64,
  maximumTotalAttributes: 256 * 1024,
  maximumAttributeValueBytes: 256 * 1024,
  maximumTotalAttributeBytes: 8 * 1024 * 1024,
  maximumProviderStringBytes: 1024 * 1024,
  maximumOutputBytes: 32 * 1024 * 1024,
  maximumWarnings: 4_096,
  maximumFormulas: 4_096,
  maximumTableRows: 4_096,
  maximumTableColumns: 256,
  maximumTableCells: 65_536,
  maximumAttachments: 65_536,
  maximumLocalLinks: 65_536,
  maximumSourceRefsPerLocalLink: 256,
  maximumTotalLocalLinkReferences: 65_536,
  maximumTotalLocalLinkReferenceBytes: 16 * 1024 * 1024,
  maximumIncrementalProjectionBytes: 32 * 1024 * 1024,
} as const);

const WARNING = Object.freeze({
  imageNotCaptured: 'Notebook image reference was not captured as an attachment.',
  inlineImageNotCaptured: 'Inline notebook image reference was not captured.',
  unsafeLink: 'Unsafe notebook link was preserved as text without a hyperlink.',
  mergedTableCell: 'A notebook table merged cell was preserved without merge behavior.',
  unsupportedFormula:
    'A notebook table formula was preserved as a non-recalculating source result.',
  unsupportedWidget: 'An unsupported Benchling widget was preserved as an inline artifact block.',
  malformedList: 'A malformed Benchling list row was preserved as ordinary notebook text.',
  rebasedList:
    'A Benchling list began without an exported parent; DNAForge preserved it as a new top-level list.',
  clampedListDepth:
    'A Benchling list row was nested deeper than its exported ancestors; DNAForge preserved it at the deepest available level.',
});

type HtmlText = { kind: 'text'; value: string };
type HtmlElement = {
  kind: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  svgSource?: string;
};
type HtmlNode = HtmlText | HtmlElement;

type TipTapMark = { type: string; attrs?: Record<string, unknown> };
type TipTapNode = JSONContent;

type BenchlingOrderedListType = '1' | 'a' | 'A' | 'i' | 'I';
type BenchlingListKind = 'ordered' | 'bullet' | 'task';
type BenchlingTextRowParts = {
  element: HtmlElement;
  indenter: HtmlElement;
  editable: HtmlElement;
  marker: HtmlElement | null;
  markerCount: number;
  indentDepth: number | null;
};
type BenchlingListRow = BenchlingTextRowParts & {
  kind: BenchlingListKind;
  depth: number;
  markerText: string;
  orderedStart?: number;
  orderedType?: BenchlingOrderedListType;
  checked?: boolean;
};
type BenchlingProtocolStep = {
  editable: HtmlElement;
  ordinal: number;
  checked: boolean;
};

export type NotebookAttachmentBinding = {
  sourceRef: string;
  hash: string;
  fileName: string;
  workspacePath: string;
  mediaType?: string;
};

export type NotebookAttachmentReference = NotebookAttachmentBinding & {
  occurrences: number;
};

export type NotebookFormulaCompatibility = {
  tableId: string;
  cell: string;
  formula: string;
  sourceRenderedValue: string;
  compatibility: 'supported' | 'unsupported';
};

export type NotebookHtmlProjectionOptions = {
  destinationEntityId?: string;
  capturedAt: string;
  converterVersion: string;
  migrationRunId?: string;
  notebookPackagePath?: string;
  attachments: NotebookAttachmentBinding[];
  localLinks?: NotebookLocalLinkBinding[];
  supportedFormulaNames: readonly string[];
};

export type NotebookLocalLinkBinding = {
  relationshipId: string;
  relationType: string;
  sourceTargetId: string;
  destinationTargetId: string;
  sourceRefs: string[];
};

export type NotebookHtmlProjection = {
  converterId: 'benchling-notebook-html-v1';
  converterVersion: string;
  destinationObjectId: string;
  packageName: string;
  document: NotebookPackageDocument & { content: JSONContent };
  attachmentReferences: NotebookAttachmentReference[];
  formulas: NotebookFormulaCompatibility[];
  unsupportedWidgetCount: number;
  warnings: string[];
};

export type BenchlingEntryExportMetadata = {
  schema: 'dnaforge.benchling.entry-export-metadata.v1';
  project?: string;
  author?: string;
  status?: string;
  entryCreatedOn?: string;
  entryLastModified?: string;
  exportGeneratedOn?: string;
};

type ProjectionContext = {
  source: SourceObject;
  persistedSourceObjectId: string;
  persistedStableSourceId: string;
  sourceBaseUrl: string;
  attachments: AttachmentResolver;
  localLinks: LocalLinkResolver;
  supportedFormulaNames: ReadonlySet<string>;
  warnings: string[];
  formulas: NotebookFormulaCompatibility[];
  tableIndex: number;
  artifactIndex: number;
  unsupportedWidgetCount: number;
  totalTableCells: number;
  incrementalProjectionBytes: number;
  migrationRunId: string | null;
  notebookPackagePath: string | null;
};

type HtmlParseBudget = {
  nodes: number;
  attributes: number;
  attributeBytes: number;
};

export function buildNotebookHtmlProjection(
  sourceObject: SourceObject,
  options: NotebookHtmlProjectionOptions
): NotebookHtmlProjection {
  if (!sourceObject.sourceType.toLowerCase().includes('notebook')) {
    throw new Error(`Source type "${sourceObject.sourceType}" is not a notebook.`);
  }
  const capturedAt = requiredTimestamp(options.capturedAt, 'capturedAt');
  const converterVersion = requiredText(options.converterVersion, 'converterVersion');
  const migrationRunId =
    options.migrationRunId === undefined
      ? null
      : requiredText(options.migrationRunId, 'migrationRunId');
  const notebookPackagePath =
    options.notebookPackagePath === undefined
      ? null
      : safeWorkspaceRelativePath(options.notebookPackagePath, 'notebookPackagePath');
  const html = notebookHtml(sourceObject.content);
  const sourceBaseUrl = safeSourceUrl(sourceObject.sourceUrl);
  const sourceName = requiredProviderText(sourceObject.name, 'Notebook name');
  const persistedSourceObjectId = requiredProviderText(sourceObject.id, 'Source object ID');
  const persistedStableSourceId = requiredProviderText(sourceObject.stableId, 'Stable source ID');
  const attachments = new AttachmentResolver(
    options.attachments,
    sourceBaseUrl,
    sourceName,
    persistedStableSourceId
  );
  const context: ProjectionContext = {
    source: sourceObject,
    persistedSourceObjectId,
    persistedStableSourceId,
    sourceBaseUrl,
    attachments,
    localLinks: new LocalLinkResolver(options.localLinks ?? [], sourceBaseUrl),
    supportedFormulaNames: new Set(
      options.supportedFormulaNames.map((name) => name.trim().toUpperCase()).filter(Boolean)
    ),
    warnings: [],
    formulas: [],
    tableIndex: 0,
    artifactIndex: 0,
    unsupportedWidgetCount: 0,
    totalTableCells: 0,
    incrementalProjectionBytes: 0,
    migrationRunId,
    notebookPackagePath,
  };

  const parsed = parseHtml(html);
  const benchlingEntryMetadata = extractBenchlingEntryExportMetadata(parsed);
  annotateBenchlingTablePresentation(parsed);
  const contentRoot = findContentRoot(parsed);
  const content = sanitizeTipTapTextRuns(
    ensureDocumentContent(
      removeDuplicateTitle(convertFlow(contentRoot.children, context), sourceName)
    )
  );
  const destinationObjectId =
    options.destinationEntityId ?? `notebook-${sha256(sourceObject.stableId).slice(0, 24)}`;
  const attachmentReferences = attachments.references();
  const packageName = safeFileStem(`${sourceName}__${sha256(sourceObject.stableId).slice(0, 16)}`);
  const updatedAt = optionalTimestamp(sourceObject.modifiedAt) ?? capturedAt;
  const notebookContent: JSONContent = { type: 'doc', content };
  const document = buildNotebookPackageDocument({
    id: destinationObjectId,
    title: sourceName,
    content: notebookContent,
    updatedAt,
    existing: {
      provenance: {
        immutableSource: true,
        provider: 'benchling',
        sourceObjectId: persistedSourceObjectId,
        stableSourceId: persistedStableSourceId,
        sourceUrl: sourceBaseUrl,
        sourceSchemaId:
          sourceObject.schemaId === undefined
            ? null
            : requiredProviderText(sourceObject.schemaId, 'Source schema ID'),
        sourceCreatedAt: optionalTimestamp(sourceObject.createdAt),
        sourceModifiedAt: optionalTimestamp(sourceObject.modifiedAt),
        capturedAt,
        ...(benchlingEntryMetadata ? { benchlingEntryMetadata } : {}),
      },
      migration: {
        converterId: 'benchling-notebook-html-v1',
        converterVersion,
        attachmentHashes: attachmentReferences.map((attachment) => attachment.hash),
        formulaCompatibility: {
          supported: context.formulas.filter((formula) => formula.compatibility === 'supported')
            .length,
          unsupported: context.formulas.filter((formula) => formula.compatibility === 'unsupported')
            .length,
        },
        unsupportedWidgetCount: context.unsupportedWidgetCount,
      },
    },
  });

  const projection: NotebookHtmlProjection = {
    converterId: 'benchling-notebook-html-v1',
    converterVersion,
    destinationObjectId,
    packageName,
    document: { ...document, content: notebookContent },
    attachmentReferences,
    formulas: context.formulas,
    unsupportedWidgetCount: context.unsupportedWidgetCount,
    warnings: [...new Set(context.warnings)],
  };
  assertProjectionOutputBudget(projection);
  return projection;
}

export function classifyNotebookFormula(
  formula: string,
  supportedFormulaNames: ReadonlySet<string>
): 'supported' | 'unsupported' {
  const value = formula.trim();
  if (!value.startsWith('=') || value.length === 1) return 'unsupported';
  if (/^=\s*"(?:[^"]|"")*"\s*$/.test(value)) return 'unsupported';
  const expression = stripQuotedStrings(value.slice(1));
  if (!balancedParentheses(expression)) return 'unsupported';
  if (['!', '[', ']', '{', '}', ';', '%', '^'].some((token) => expression.includes(token))) {
    return 'unsupported';
  }

  const calledFunctions = [...expression.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(
    (match) => match[1].toUpperCase()
  );
  if (calledFunctions.some((name) => !supportedFormulaNames.has(name))) return 'unsupported';

  const residue = expression
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*(?=\()/g, '')
    .replace(/\$?[A-Za-z]{1,4}\$?\d+/g, '')
    .replace(/\b(?:TRUE|FALSE)\b/gi, '')
    .replace(/[0-9eE.+\-*/(),:<>=\s]/g, '');
  return residue === '' ? 'supported' : 'unsupported';
}

function convertFlow(nodes: HtmlNode[], context: ProjectionContext): TipTapNode[] {
  const output: TipTapNode[] = [];
  let inlineBuffer: HtmlNode[] = [];
  const flushInline = () => {
    const content = normalizeInline(
      inlineBuffer.flatMap((node) => convertInline(node, [], context))
    );
    inlineBuffer = [];
    if (content.length > 0) output.push({ type: 'paragraph', content });
  };

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.kind === 'element' && isIgnorableBenchlingUiChrome(node)) continue;
    if (node.kind === 'element') {
      const benchlingRow = benchlingTextRowParts(node);
      if (benchlingRow) {
        const listRow = benchlingListRow(benchlingRow);
        if (listRow) {
          flushInline();
          const listRun = convertBenchlingListRun(nodes, index, context);
          output.push(...listRun.content);
          index = listRun.nextIndex - 1;
          continue;
        }
        if (benchlingRow.marker) {
          flushInline();
          addWarningOnce(context, WARNING.malformedList);
          output.push(...convertMalformedBenchlingListRow(benchlingRow, context));
          continue;
        }
        if ((benchlingRow.indentDepth ?? 0) > 0) {
          flushInline();
          output.push(...convertBenchlingIndentedTextRow(benchlingRow, context));
          continue;
        }
        if (isBlankBenchlingTextRow(benchlingRow)) {
          flushInline();
          output.push({ type: 'paragraph' });
          continue;
        }
      }
    }
    if (node.kind === 'text' || !BLOCK_TAGS.has(node.tag)) {
      if (
        node.kind === 'element' &&
        (node.tag === 'img' || isArtifactWidget(node) || isBenchlingLinkedFilePreview(node))
      ) {
        flushInline();
        output.push(...convertBlock(node, context));
      } else if (node.kind === 'element' && hasProjectedArtifactDescendant(node)) {
        flushInline();
        output.push(...convertFlow(node.children, context));
      } else {
        inlineBuffer.push(node);
      }
      continue;
    }
    flushInline();
    output.push(...convertBlock(node, context));
  }
  flushInline();
  return output;
}

function convertBlock(element: HtmlElement, context: ProjectionContext): TipTapNode[] {
  if (isIgnorableBenchlingUiChrome(element)) return [];
  if (isBenchlingDaySeparator(element)) {
    const date = benchlingDaySeparatorText(element);
    return date
      ? [
          {
            type: 'heading',
            attrs: { level: 3 },
            content: [projectedTextNode(date, [], context)],
          },
        ]
      : [];
  }
  if (isBenchlingLinkedFilePreview(element)) {
    return [convertBenchlingLinkedFilePreview(element, context)];
  }
  if (isArtifactWidget(element)) return [convertArtifactWidget(element, context)];
  if (/^h[1-6]$/.test(element.tag)) {
    return [
      {
        type: 'heading',
        attrs: { level: Number(element.tag.slice(1)) },
        content: normalizeInline(
          element.children.flatMap((node) => convertInline(node, [], context))
        ),
      },
      ...projectNestedArtifactWidgets(element, context),
    ];
  }
  if (element.tag === 'p' || element.tag === 'address') {
    return convertParagraphFlow(element.children, context);
  }
  if (element.tag === 'blockquote') {
    return [
      {
        type: 'blockquote',
        content: ensureDocumentContent(convertFlow(element.children, context)),
      },
    ];
  }
  if (element.tag === 'pre') {
    return [
      { type: 'codeBlock', content: [{ type: 'text', text: rawText(element).replace(/\n$/, '') }] },
      ...projectNestedArtifactWidgets(element, context),
    ];
  }
  if (element.tag === 'hr') return [{ type: 'horizontalRule' }];
  if (element.tag === 'ul' || element.tag === 'ol') {
    const protocolStep = benchlingProtocolStep(element);
    if (protocolStep) return [convertBenchlingProtocolStep(protocolStep, context)];
    const groupHeading = benchlingProtocolGroupHeading(element);
    if (groupHeading) {
      return [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: convertInline(groupHeading, [], context),
        },
      ];
    }
    return convertList(element, context);
  }
  if (element.tag === 'table') {
    return [convertTable(element, context), ...projectNestedArtifactWidgets(element, context)];
  }
  if (element.tag === 'figure') return convertFigure(element, context);
  if (element.tag === 'img') return [convertImage(element, context)];
  return convertFlow(element.children, context);
}

function convertParagraphFlow(nodes: HtmlNode[], context: ProjectionContext): TipTapNode[] {
  const output: TipTapNode[] = [];
  let inline: TipTapNode[] = [];
  const flush = () => {
    const content = normalizeInline(inline);
    inline = [];
    if (content.length > 0) output.push({ type: 'paragraph', content });
  };
  for (const node of nodes) {
    if (node.kind === 'element' && isIgnorableBenchlingUiChrome(node)) continue;
    if (
      node.kind === 'element' &&
      (node.tag === 'img' || isArtifactWidget(node) || isBenchlingLinkedFilePreview(node))
    ) {
      flush();
      output.push(...convertBlock(node, context));
    } else if (node.kind === 'element' && hasProjectedArtifactDescendant(node)) {
      flush();
      output.push(...convertFlow(node.children, context));
    } else {
      inline.push(...convertInline(node, [], context));
    }
  }
  flush();
  return output.length > 0 ? output : [{ type: 'paragraph' }];
}

function benchlingTextRowParts(element: HtmlElement): BenchlingTextRowParts | null {
  if (
    element.tag !== 'div' ||
    element.attrs['data-test-component']?.toLowerCase() !== 'mediocreitem' ||
    !hasClassToken(element, 'is-text')
  ) {
    return null;
  }

  const noteRoots = findMatchingDescendants(
    element,
    (candidate) =>
      candidate.attrs['data-test-component']?.toLowerCase() === 'noteeditable' &&
      candidate.attrs['data-test-element']?.toLowerCase() === 'root',
    2
  );
  if (noteRoots.length !== 1) return null;

  const directChildren = noteRoots[0].children.filter(
    (child): child is HtmlElement => child.kind === 'element'
  );
  const indenters = directChildren.filter(
    (candidate) =>
      candidate.attrs['data-test-component']?.toLowerCase() === 'noteeditable' &&
      candidate.attrs['data-test-element']?.toLowerCase() === 'indenter'
  );
  const editables = directChildren.filter(
    (candidate) =>
      candidate.attrs['data-test-component']?.toLowerCase() === 'editablecomponent' &&
      candidate.attrs['data-test-element']?.toLowerCase() === 'root'
  );
  if (indenters.length !== 1 || editables.length !== 1) return null;

  const markers = findMatchingDescendants(
    indenters[0],
    (candidate) => candidate.attrs['data-test-component']?.toLowerCase() === 'listsymbol',
    2
  );
  return {
    element,
    indenter: indenters[0],
    editable: editables[0],
    marker: markers.length === 1 ? markers[0] : (markers[0] ?? null),
    markerCount: markers.length,
    indentDepth: benchlingIndentDepth(indenters[0]),
  };
}

function isBlankBenchlingTextRow(parts: BenchlingTextRowParts): boolean {
  if (collapsedText(parts.editable).trim().length > 0) return false;
  if (parts.marker) return false;
  return !findFirstDescendant(
    parts.editable,
    (node) =>
      node.tag === 'img' ||
      isArtifactWidget(node) ||
      isBenchlingLinkedFilePreview(node) ||
      node.tag === 'table'
  );
}

function benchlingIndentDepth(indenter: HtmlElement): number | null {
  const width = indenter.attrs.style?.match(
    /(?:^|;)\s*width\s*:\s*([0-9]+(?:\.[0-9]+)?)px\s*(?:;|$)/iu
  )?.[1];
  if (width === undefined) return null;
  const pixels = Number(width);
  const depth = pixels / BENCHLING_LIST_INDENT_PIXELS;
  return Number.isSafeInteger(depth) &&
    depth >= 0 &&
    depth <= NOTEBOOK_HTML_PROJECTION_LIMITS.maximumDepth
    ? depth
    : null;
}

function benchlingListRow(parts: BenchlingTextRowParts): BenchlingListRow | null {
  if (
    !parts.marker ||
    parts.markerCount !== 1 ||
    parts.indentDepth === null ||
    parts.indentDepth < 1
  ) {
    return null;
  }
  const markerKind = parts.marker.attrs['data-test-element']?.toLowerCase();
  const markerText = collapsedText(parts.marker);

  if (markerKind === 'number') {
    const ordered = benchlingOrderedMarker(markerText, parts.indentDepth);
    return ordered
      ? {
          ...parts,
          kind: 'ordered',
          depth: parts.indentDepth,
          markerText,
          orderedStart: ordered.start,
          orderedType: ordered.type,
        }
      : null;
  }
  if (markerKind === 'bullet' && ['●', '○', '■'].includes(markerText)) {
    return {
      ...parts,
      kind: 'bullet',
      depth: parts.indentDepth,
      markerText,
    };
  }
  if (markerKind === 'checkbox' && parts.marker.tag === 'input') {
    return {
      ...parts,
      kind: 'task',
      depth: parts.indentDepth,
      markerText: benchlingTaskMarker(parts.marker),
      checked: benchlingCheckboxChecked(parts.marker),
    };
  }
  return null;
}

function benchlingOrderedMarker(
  markerText: string,
  depth: number
): { start: number; type: BenchlingOrderedListType } | null {
  const decimal = markerText.match(/^(\d+)\.$/u);
  if (decimal) {
    const start = Number(decimal[1]);
    return Number.isSafeInteger(start) && start > 0 ? { start, type: '1' } : null;
  }

  const letters = markerText.match(/^([A-Za-z]+)\.$/u)?.[1];
  if (!letters) return null;
  const expectsRoman = depth % 3 === 0;
  if (expectsRoman) {
    const start = romanNumeralValue(letters);
    if (start !== null) {
      return { start, type: letters === letters.toUpperCase() ? 'I' : 'i' };
    }
  }
  const start = alphabeticListValue(letters);
  if (start === null) return null;
  return { start, type: letters === letters.toUpperCase() ? 'A' : 'a' };
}

function alphabeticListValue(value: string): number | null {
  let result = 0;
  for (const character of value.toUpperCase()) {
    const digit = character.charCodeAt(0) - 64;
    if (digit < 1 || digit > 26) return null;
    result = result * 26 + digit;
    if (!Number.isSafeInteger(result) || result < 1) return null;
  }
  return result || null;
}

function romanNumeralValue(value: string): number | null {
  const normalized = value.toUpperCase();
  if (
    !/^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/u.test(normalized) ||
    !normalized
  ) {
    return null;
  }
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1_000 };
  let result = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const current = values[normalized[index]];
    const next = values[normalized[index + 1]] ?? 0;
    result += current < next ? -current : current;
  }
  return result > 0 ? result : null;
}

function benchlingCheckboxChecked(marker: HtmlElement): boolean {
  return (
    Object.hasOwn(marker.attrs, 'checked') || marker.attrs['aria-checked']?.toLowerCase() === 'true'
  );
}

function benchlingTaskMarker(marker: HtmlElement): string {
  return benchlingCheckboxChecked(marker) ? '[x]' : '[ ]';
}

function convertBenchlingListRun(
  nodes: HtmlNode[],
  startIndex: number,
  context: ProjectionContext
): { content: TipTapNode[]; nextIndex: number } {
  const rows: BenchlingListRow[] = [];
  let nextIndex = startIndex;
  while (nextIndex < nodes.length) {
    const node = nodes[nextIndex];
    if (node.kind === 'text' && !node.value.trim()) {
      nextIndex += 1;
      continue;
    }
    if (node.kind === 'element' && isIgnorableBenchlingUiChrome(node)) {
      nextIndex += 1;
      continue;
    }
    if (node.kind !== 'element') break;
    const parts = benchlingTextRowParts(node);
    const row = parts ? benchlingListRow(parts) : null;
    if (!row) break;
    rows.push(row);
    nextIndex += 1;
  }
  return { content: convertBenchlingListRows(rows, context), nextIndex };
}

type BenchlingListFrame = {
  kind: BenchlingListKind;
  orderedType?: BenchlingOrderedListType;
  list: TipTapNode;
  parentItem: TipTapNode | null;
  lastItem: TipTapNode | null;
  nextOrderedStart?: number;
};

function convertBenchlingListRows(
  rows: BenchlingListRow[],
  context: ProjectionContext
): TipTapNode[] {
  const output: TipTapNode[] = [];
  const frames: BenchlingListFrame[] = [];
  let depthOffset = 0;
  let parentlessIndent = 0;

  for (const row of rows) {
    let depth = row.depth - depthOffset;
    if (depth < 1) {
      if (row.depth > 1) addWarningOnce(context, WARNING.rebasedList);
      frames.length = 0;
      depthOffset = row.depth - 1;
      depth = 1;
    } else if (depth > frames.length + 1) {
      const clampedDepth = frames.length + 1;
      if (frames.length === 0) {
        addWarningOnce(context, WARNING.rebasedList);
        parentlessIndent = row.depth - 1;
      } else {
        addWarningOnce(context, WARNING.clampedListDepth);
      }
      depthOffset = row.depth - clampedDepth;
      depth = clampedDepth;
    }

    frames.length = Math.min(frames.length, depth);
    const parentItem = depth === 1 ? null : (frames[depth - 2]?.lastItem ?? null);

    let frame = frames[depth - 1];
    const canReuse =
      frame?.parentItem === parentItem &&
      frame.kind === row.kind &&
      (row.kind !== 'ordered' ||
        (frame.orderedType === row.orderedType && frame.nextOrderedStart === row.orderedStart));
    if (!canReuse) {
      const list = benchlingListNode(row, depth === 1 ? parentlessIndent : 0);
      parentlessIndent = 0;
      if (parentItem) {
        parentItem.content = [...(parentItem.content ?? []), list];
      } else {
        output.push(list);
      }
      frame = {
        kind: row.kind,
        orderedType: row.orderedType,
        list,
        parentItem,
        lastItem: null,
        nextOrderedStart: row.orderedStart,
      };
      frames[depth - 1] = frame;
    }
    frames.length = depth;

    const item = benchlingListItemNode(row, context);
    frame.list.content = [...(frame.list.content ?? []), item];
    frame.lastItem = item;
    if (row.kind === 'ordered') frame.nextOrderedStart = (row.orderedStart as number) + 1;
  }
  return output;
}

function benchlingListNode(row: BenchlingListRow, indent = 0): TipTapNode {
  const indentAttr = indent > 0 ? { indent } : {};
  if (row.kind === 'ordered') {
    return {
      type: 'orderedList',
      attrs: { start: row.orderedStart, type: row.orderedType, ...indentAttr },
      content: [],
    };
  }
  const type = row.kind === 'task' ? 'taskList' : 'bulletList';
  return indent > 0 ? { type, attrs: indentAttr, content: [] } : { type, content: [] };
}

function benchlingListItemNode(row: BenchlingListRow, context: ProjectionContext): TipTapNode {
  const content = listItemContent(convertParagraphFlow(row.editable.children, context));
  return row.kind === 'task'
    ? { type: 'taskItem', attrs: { checked: row.checked === true }, content }
    : { type: 'listItem', content };
}

function convertBenchlingIndentedTextRow(
  row: BenchlingTextRowParts,
  context: ProjectionContext
): TipTapNode[] {
  const indent = row.indentDepth ?? 0;
  return convertParagraphFlow(row.editable.children, context).map((node) =>
    node.type === 'paragraph' ? { ...node, attrs: { ...(node.attrs ?? {}), indent } } : node
  );
}

function convertMalformedBenchlingListRow(
  row: BenchlingTextRowParts | BenchlingListRow,
  context: ProjectionContext
): TipTapNode[] {
  const projected = convertParagraphFlow(row.editable.children, context);
  const markerText =
    'markerText' in row
      ? row.markerText
      : row.marker
        ? collapsedText(row.marker) ||
          (row.marker.attrs['data-test-element']?.toLowerCase() === 'checkbox'
            ? benchlingTaskMarker(row.marker)
            : '')
        : '';
  if (!markerText) return projected;
  const markerNode = projectedTextNode(`${markerText} `, [], context);
  const paragraphIndex = projected.findIndex((node) => node.type === 'paragraph');
  if (paragraphIndex < 0) return [{ type: 'paragraph', content: [markerNode] }, ...projected];
  const paragraph = projected[paragraphIndex];
  projected[paragraphIndex] = {
    ...paragraph,
    content: [markerNode, ...(paragraph.content ?? [])],
  };
  return projected;
}

function convertList(element: HtmlElement, context: ProjectionContext): TipTapNode[] {
  const items = element.children
    .filter((child): child is HtmlElement => child.kind === 'element' && child.tag === 'li')
    .map((item) => ({
      type: 'listItem',
      content: listItemContent(convertFlow(item.children, context)),
    }));
  if (items.length === 0) return [];
  if (element.tag === 'ol') {
    const start = positiveInteger(element.attrs.start) ?? 1;
    return [{ type: 'orderedList', attrs: { start }, content: items }];
  }
  return [{ type: 'bulletList', content: items }];
}

function benchlingProtocolGroupHeading(element: HtmlElement): HtmlElement | null {
  if (element.tag !== 'ul' || !hasClassToken(element, 'headers')) return null;

  const items = element.children.filter(
    (child): child is HtmlElement => child.kind === 'element' && child.tag === 'li'
  );
  if (items.length !== 1) return null;

  const editableWrappers = items[0].children.filter(
    (child): child is HtmlElement =>
      child.kind === 'element' && hasClassToken(child, 'step-editable-wrapper')
  );
  if (editableWrappers.length !== 1) return null;

  const editables = findMatchingDescendants(
    editableWrappers[0],
    (candidate) =>
      hasClassToken(candidate, 'step-editable') &&
      candidate.attrs['data-test-component']?.toLowerCase() === 'editablecomponent' &&
      candidate.attrs['data-test-element']?.toLowerCase() === 'root',
    2
  );
  return editables.length === 1 ? editables[0] : null;
}

function benchlingProtocolStep(element: HtmlElement): BenchlingProtocolStep | null {
  if (element.tag !== 'ol' || !hasClassToken(element, 'steps')) return null;

  const items = element.children.filter(
    (child): child is HtmlElement => child.kind === 'element' && child.tag === 'li'
  );
  if (items.length !== 1) return null;

  const ordinal = positiveInteger(items[0].attrs.value);
  if (ordinal === null) return null;

  const directChildren = items[0].children.filter(
    (child): child is HtmlElement => child.kind === 'element'
  );
  const checkboxes = directChildren.filter((child) => hasClassToken(child, 'step-checkbox'));
  const editableWrappers = directChildren.filter((child) =>
    hasClassToken(child, 'step-editable-wrapper')
  );
  if (checkboxes.length !== 1 || editableWrappers.length !== 1) return null;

  const editables = findMatchingDescendants(
    editableWrappers[0],
    (candidate) =>
      hasClassToken(candidate, 'step-editable') &&
      candidate.attrs['data-test-component']?.toLowerCase() === 'editablecomponent' &&
      candidate.attrs['data-test-element']?.toLowerCase() === 'root',
    2
  );
  if (editables.length !== 1) return null;

  return {
    editable: editables[0],
    ordinal,
    checked: hasClassToken(checkboxes[0], 'checked'),
  };
}

function convertBenchlingProtocolStep(
  step: BenchlingProtocolStep,
  context: ProjectionContext
): TipTapNode {
  const projected = convertParagraphFlow(step.editable.children, context);

  return {
    type: 'orderedList',
    attrs: { start: step.ordinal, type: '1' },
    content: [
      {
        type: 'listItem',
        attrs: { checked: step.checked },
        content: listItemContent(projected),
      },
    ],
  };
}

function convertFigure(element: HtmlElement, context: ProjectionContext): TipTapNode[] {
  const image = findFirstDescendant(element, (node) => node.tag === 'img');
  if (!image) return convertFlow(element.children, context);
  const caption = findFirstDescendant(element, (node) => node.tag === 'figcaption');
  const projected = convertImage(image, context);
  if (projected.attrs?.data && caption) {
    projected.attrs.data = {
      ...(projected.attrs.data as Record<string, unknown>),
      caption: collapsedText(caption),
    };
  }
  return [projected, ...projectNestedArtifactWidgets(element, context)];
}

function convertBenchlingLinkedFilePreview(
  element: HtmlElement,
  context: ProjectionContext
): TipTapNode {
  const nameElement = findFirstDescendant(
    element,
    (node) =>
      node.attrs['data-test-element'] === 'previewItemName' || hasClassToken(node, 'note-itemName')
  );
  const displayName = nameElement ? collapsedText(nameElement) : '';
  if (isBenchlingEmbeddedEntryPreview(element)) {
    const anchor = findFirstDescendant(
      element,
      (node) =>
        node.tag === 'a' &&
        (Boolean(node.attrs.href?.trim()) ||
          benchlingInternalLinkTargetId(node.attrs['data-internal-link']) !== null)
    );
    const href = anchor?.attrs.href?.trim() ?? '';
    const internalLinkTargetId = benchlingInternalLinkTargetId(anchor?.attrs['data-internal-link']);
    const localLink =
      (href ? context.localLinks.resolve(href) : null) ??
      (internalLinkTargetId ? context.localLinks.resolve(internalLinkTargetId) : null) ??
      (displayName ? context.localLinks.resolve(displayName) : null);
    if (!localLink) {
      const pendingReference = pendingBenchlingReferenceNode(element, context, {
        displayName,
        targetSourceId: internalLinkTargetId,
        href,
      });
      if (pendingReference) return pendingReference;
      return artifactNode(element, context, {
        artifactType: 'unresolved-entry-reference',
        name: displayName || 'Unresolved Benchling entry reference',
      });
    }
    reserveIncrementalLocalLinkMark(context, localLink);
    return {
      type: 'paragraph',
      content: [
        projectedTextNode(
          displayName,
          [
            {
              type: 'link',
              attrs: {
                href: requiredNativeEntityHref(localLink.destinationTargetId),
                target: null,
                rel: null,
                relationshipId: localLink.relationshipId,
                relationType: localLink.relationType,
                sourceTargetId: localLink.sourceTargetId,
                destinationTargetId: localLink.destinationTargetId,
              },
            },
          ],
          context
        ),
      ],
    };
  }
  const image = findFirstDescendant(
    element,
    (node) =>
      node.tag === 'img' &&
      (hasClassToken(node, 'noteLinkedFilePreviewImg') ||
        node.attrs['data-test-component'] === 'NoteLinkedFilePreview')
  );
  if (!image) {
    return artifactNode(element, context, {
      artifactType: 'unresolved-linked-file',
      name: 'Unresolved Benchling linked file',
    });
  }
  const identifier =
    optionalProviderText(image.attrs.efl_identifier) ??
    optionalProviderText(image.attrs['data-test-key']);
  const attachment =
    displayName && identifier
      ? context.attachments.resolveLinkedFile(identifier, displayName)
      : null;
  return convertImage(image, context, {
    resolvedAttachment: attachment,
    ...(displayName ? { displayName } : {}),
  });
}

function convertImage(
  element: HtmlElement,
  context: ProjectionContext,
  overrides: {
    resolvedAttachment?: NotebookAttachmentBinding | null;
    displayName?: string;
  } = {}
): TipTapNode {
  const sourceRef = element.attrs.src ?? '';
  const attachment = Object.prototype.hasOwnProperty.call(overrides, 'resolvedAttachment')
    ? (overrides.resolvedAttachment ?? null)
    : context.attachments.resolve(sourceRef);
  const persistedSourceRef =
    attachment?.sourceRef ?? safeLink(sourceRef, context.sourceBaseUrl) ?? null;
  const sourceAlt = optionalProviderText(element.attrs.alt);
  const displayName = optionalProviderText(overrides.displayName);
  const alt =
    displayName ??
    (sourceAlt?.toLowerCase() === 'thumbnail' ? null : sourceAlt) ??
    attachment?.fileName ??
    'Imported image';
  if (attachment) {
    return {
      type: 'embed',
      attrs: {
        type: 'image',
        refId: `image-${sha256(`${context.source.stableId}:${attachment.hash}`).slice(0, 20)}`,
        data: {
          src: attachment.workspacePath,
          source: 'captured',
          alt,
          fileName: displayName ?? attachment.fileName,
          archiveHash: attachment.hash,
          sourceRef: persistedSourceRef,
          mediaType: attachment.mediaType ?? null,
          ...(context.migrationRunId ? { migrationRunId: context.migrationRunId } : {}),
          ...(context.notebookPackagePath
            ? { notebookPackagePath: context.notebookPackagePath }
            : {}),
        },
      },
    };
  }
  addWarning(context, WARNING.imageNotCaptured);
  return artifactNode(
    element,
    context,
    {
      artifactType: 'unresolved-image',
      name: alt,
      sourceRef: persistedSourceRef,
    },
    false
  );
}

type BenchlingCellPlacement = { column: number; colspan: number; rowspan: number };

function benchlingCellPlacements(rowCells: HtmlElement[][]): BenchlingCellPlacement[][] {
  const occupied = new Set<string>();
  const maxSpan = NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTableColumns;
  return rowCells.map((cells, rowIndex) => {
    let column = 0;
    return cells.map((cell) => {
      while (occupied.has(`${rowIndex}:${column}`)) column += 1;
      const colspan = Math.min(positiveInteger(cell.attrs.colspan) ?? 1, maxSpan);
      const rowspan = Math.min(positiveInteger(cell.attrs.rowspan) ?? 1, rowCells.length || 1);
      for (let row = rowIndex; row < rowIndex + rowspan; row += 1) {
        for (let col = column; col < column + colspan; col += 1) occupied.add(`${row}:${col}`);
      }
      const placement = { column, colspan, rowspan };
      column += colspan;
      return placement;
    });
  });
}

function benchlingCoveredCell(): TipTapNode {
  return { type: 'text', value: '', covered: true };
}

function convertTable(element: HtmlElement, context: ProjectionContext): TipTapNode {
  const tableIndex = ++context.tableIndex;
  const tableId = `table-${sha256(`${context.source.stableId}:${tableIndex}`).slice(0, 20)}`;
  const sourceRows = collectTableRows(element);
  if (sourceRows.length > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTableRows) {
    throw new Error('Notebook table exceeds the bounded row limit.');
  }
  const isBenchlingEditable = isBenchlingEditableTable(element);
  const headerRow = isBenchlingEditable
    ? (sourceRows.find((row) => directTableCells(row).some(isBenchlingColumnAxisCell)) ?? null)
    : null;
  const columnLabels = headerRow
    ? directTableCells(headerRow).filter(isBenchlingColumnAxisCell).map(tableCellText)
    : [];
  const rows = sourceRows.filter((row) => row !== headerRow);
  const rowCells = rows
    .map((row) =>
      directTableCells(row).filter((cell) => !isBenchlingEditable || !isBenchlingAxisCell(cell))
    )
    .filter((cells) => !isBenchlingEditable || cells.length > 0)
    .map((cells) =>
      cells.filter(
        (cell) =>
          !isBenchlingEditable ||
          !(hasClassToken(cell, 'cell-hiddenMergedCell') && cell.attrs['aria-hidden'] === 'true')
      )
    );
  const placements = benchlingCellPlacements(rowCells);
  let actualCellCount = 0;
  const parsedRows = rowCells.map((cells, rowIndex) =>
    cells.map((cell, cellIndex) => {
      const columnIndex = placements[rowIndex][cellIndex].column;
      if (columnIndex >= NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTableColumns) {
        throw new Error('Notebook table exceeds the bounded column limit.');
      }
      actualCellCount += 1;
      if (
        context.totalTableCells + actualCellCount >
        NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTableCells
      ) {
        throw new Error('Notebook tables exceed the bounded cell limit.');
      }
      if (
        (positiveInteger(cell.attrs.rowspan) ?? 1) !== 1 ||
        (positiveInteger(cell.attrs.colspan) ?? 1) !== 1
      ) {
        addWarning(context, WARNING.mergedTableCell);
      }
      const sourceRenderedValue = tableCellText(cell);
      const format = tableCellFormat(cell, isBenchlingEditable);
      const reference = tableCellReference(cell, context);
      const rawFormula = formulaAttribute(cell);
      if (!rawFormula) {
        return withTableCellReference(
          withTableCellFormat(numericCell(sourceRenderedValue), format),
          reference
        );
      }
      const formula = requiredProviderText(rawFormula, 'Notebook formula');
      const compatibility = classifyNotebookFormula(formula, context.supportedFormulaNames);
      addFormula(context, {
        tableId,
        cell: cellAddress(rowIndex, columnIndex),
        formula,
        sourceRenderedValue,
        compatibility,
      });
      if (compatibility === 'supported') {
        return withTableCellReference(
          withTableCellFormat(
            {
              type: 'formula',
              value: formula,
              computed: numericValue(sourceRenderedValue) ?? sourceRenderedValue,
              formulaCompatibility: 'supported',
              sourceRenderedValue,
            },
            format
          ),
          reference
        );
      }
      addWarning(context, WARNING.unsupportedFormula);
      return withTableCellReference(
        withTableCellFormat(
          {
            type: 'text',
            value: sourceRenderedValue,
            sourceFormula: formula,
            sourceRenderedValue,
            formulaCompatibility: 'unsupported',
            stale: false,
          },
          format
        ),
        reference
      );
    })
  );

  const scattered: Array<Array<TipTapNode | undefined>> = parsedRows.map(() => []);
  parsedRows.forEach((cells, rowIndex) => {
    cells.forEach((cell, cellIndex) => {
      const placement = placements[rowIndex]?.[cellIndex];
      if (!placement) return;
      if (placement.colspan === 1 && placement.rowspan === 1) {
        scattered[rowIndex][placement.column] = cell;
        return;
      }
      const rowspan = Math.min(placement.rowspan, scattered.length - rowIndex);
      scattered[rowIndex][placement.column] = {
        ...cell,
        span: { rows: rowspan, cols: placement.colspan },
      };
      for (let row = rowIndex; row < rowIndex + rowspan; row += 1) {
        for (let col = placement.column; col < placement.column + placement.colspan; col += 1) {
          if (row === rowIndex && col === placement.column) continue;
          if (!scattered[row]) continue;
          scattered[row][col] = benchlingCoveredCell();
        }
      }
    });
  });
  parsedRows.length = 0;
  parsedRows.push(
    ...scattered.map((row) => Array.from(row, (cell) => cell ?? { type: 'text', value: '' }))
  );

  const columnWidths = tableColumnWidths(element, isBenchlingEditable);
  const widthColumnCount = Math.max(
    0,
    ...Object.keys(columnWidths).map((index) => Number(index) + 1)
  );
  const cols = Math.max(
    columnLabels.length,
    widthColumnCount,
    parsedRows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  );
  const rectangularCellCount = parsedRows.length * cols;
  if (
    cols > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTableColumns ||
    context.totalTableCells + rectangularCellCount >
      NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTableCells
  ) {
    throw new Error('Notebook table exceeds its bounded rectangular cell limit.');
  }
  context.totalTableCells += rectangularCellCount;
  for (const row of parsedRows) {
    while (row.length < cols) row.push({ type: 'text', value: '' });
  }
  const name =
    optionalProviderText(element.attrs['data-name']) ||
    optionalProviderText(element.attrs['aria-label']) ||
    `Table ${tableIndex}`;
  return {
    type: 'embed',
    attrs: {
      type: 'table',
      refId: tableId,
      data: {
        id: tableId,
        name,
        rows: parsedRows.length,
        cols,
        cells: parsedRows,
        presentation: 'document',
        ...(columnLabels.length > 0 ? { columnLabels: padStrings(columnLabels, cols) } : {}),
        ...(Object.keys(columnWidths).length > 0 ? { columnWidths } : {}),
        source: 'benchling-notebook-html',
      },
    },
  };
}

function convertInline(
  node: HtmlNode,
  marks: TipTapMark[],
  context: ProjectionContext
): TipTapNode[] {
  if (node.kind === 'text') {
    const text = node.value.replace(/\s+/g, ' ');
    return text ? [projectedTextNode(text, marks, context)] : [];
  }
  if (isIgnorableBenchlingUiChrome(node)) return [];
  if (node.tag === 'br') return [{ type: 'hardBreak' }];
  if (node.tag === 'img') {
    const attachment = context.attachments.resolve(node.attrs.src ?? '');
    const label = optionalProviderText(node.attrs.alt) ?? attachment?.fileName ?? 'Image';
    if (attachment) {
      return [
        projectedTextNode(
          `[${label}]`,
          [...marks, { type: 'link', attrs: { href: attachment.workspacePath } }],
          context
        ),
      ];
    }
    addWarning(context, WARNING.inlineImageNotCaptured);
    return [projectedTextNode(`[Unresolved image: ${label}]`, marks, context)];
  }

  let nextMarks = marks;
  const markType = inlineMarkType(node.tag);
  if (markType) nextMarks = [...marks, { type: markType }];

  const style = inlineStyleDeclarations(node.attrs.style);
  const highlight = safeInlineColor(style['background-color']);
  if (highlight) {
    nextMarks = [...nextMarks, { type: 'highlight', attrs: { color: highlight } }];
  }
  const textColor = safeInlineColor(style.color);
  if (textColor) {
    nextMarks = [...nextMarks, { type: 'textColor', attrs: { color: textColor } }];
  }
  if (node.tag === 'a') {
    const anchorMarks = highlight
      ? [...marks, { type: 'highlight', attrs: { color: highlight } }]
      : marks;
    const href = node.attrs.href ?? '';
    const attachment = context.attachments.resolve(href);
    if (attachment) {
      nextMarks = [...anchorMarks, { type: 'link', attrs: { href: attachment.workspacePath } }];
    } else {
      const localLink = context.localLinks.resolve(href);
      if (localLink) {
        reserveIncrementalLocalLinkMark(context, localLink);
        nextMarks = [
          ...anchorMarks,
          {
            type: 'link',
            attrs: {
              href: requiredNativeEntityHref(localLink.destinationTargetId),
              target: null,
              rel: null,
              relationshipId: localLink.relationshipId,
              relationType: localLink.relationType,
              sourceTargetId: localLink.sourceTargetId,
              destinationTargetId: localLink.destinationTargetId,
            },
          },
        ];
      } else {
        const safeHref = safeLink(href, context.sourceBaseUrl);
        if (safeHref) {
          const providerStableId = providerStableIdFromUrl(safeHref);
          const providerObjectClass = providerStableId
            ? providerObjectClassForStableId(providerStableId)
            : null;
          nextMarks = [
            ...anchorMarks,
            {
              type: 'link',
              attrs: {
                href: safeHref,
                target: '_blank',
                rel: 'noopener noreferrer',
                ...(providerStableId && providerObjectClass
                  ? { providerStableId, providerObjectClass }
                  : {}),
              },
            },
          ];
        } else if (href) {
          addWarning(context, WARNING.unsafeLink);
        }
      }
    }
  }
  return node.children.flatMap((child) => convertInline(child, nextMarks, context));
}

function projectedTextNode(
  text: string,
  marks: TipTapMark[],
  context: ProjectionContext
): TipTapNode {
  const persistedMarks = stableMarks(marks);
  reserveIncrementalTextProjection(context, text, persistedMarks);
  return {
    type: 'text',
    text,
    ...(persistedMarks ? { marks: persistedMarks } : {}),
  };
}

function pendingBenchlingReferenceNode(
  element: HtmlElement,
  context: ProjectionContext,
  input: { displayName: string; targetSourceId: string | null; href: string }
): TipTapNode | null {
  const stableObjectId = input.targetSourceId;
  if (!stableObjectId || !isExactProviderStableId(stableObjectId)) return null;
  const objectClass = providerObjectClassForStableId(stableObjectId);
  if (!objectClass) return null;

  const relationship = context.source.relationships.find(
    (candidate) => candidate.targetSourceId === stableObjectId
  );
  const safeUrl = input.href ? safeLink(input.href, context.sourceBaseUrl) : null;
  const canonicalUrl =
    relationship?.targetUrl && isSafeProviderCanonicalUrl(relationship.targetUrl)
      ? relationship.targetUrl
      : isSafeProviderCanonicalUrl(safeUrl)
        ? safeUrl
        : null;
  const referenceIndex = ++context.artifactIndex;
  const refId = `benchling-reference-${sha256(
    `${context.source.stableId}:${stableObjectId}:${referenceIndex}`
  ).slice(0, 20)}`;

  return {
    type: 'embed',
    attrs: {
      type: 'benchling-reference',
      refId,
      data: {
        refId,
        sourceNotebookId: context.persistedStableSourceId,
        relationshipId: relationship?.id ?? refId,
        relationType: relationship?.relationType ?? 'references',
        target: {
          provider: 'benchling',
          stableObjectId,
          objectClass,
          canonicalUrl,
          providerAccountHint: null,
        },
        expectedObjectClass: objectClass,
        label: input.displayName || stableObjectId,
        sourceUrl: canonicalUrl,
        disposition: relationship?.sourceBroken ? 'source_broken' : 'pending',
      },
    },
  };
}

function convertArtifactWidget(element: HtmlElement, context: ProjectionContext): TipTapNode {
  if (element.tag !== 'svg') return artifactNode(element, context);
  const preview = staticSvgImage(element.svgSource);
  if (preview.kind === 'unavailable') {
    context.unsupportedWidgetCount += 1;
    const reason = `SVG figure unavailable: ${preview.reason} The original remains in the source ZIP.`;
    addWarning(context, reason);
    return { type: 'paragraph', content: [{ type: 'text', text: reason }] };
  }
  const alt =
    optionalProviderText(element.attrs['aria-label']) ??
    optionalProviderText(element.attrs.title) ??
    'Imported SVG figure';
  return {
    type: 'embed',
    attrs: {
      type: 'image',
      refId: `svg-${sha256(`${context.source.stableId}:${++context.artifactIndex}`).slice(0, 20)}`,
      data: {
        src: preview.src,
        source: 'upload',
        alt,
        fileName: `${alt}.svg`,
        mediaType: 'image/svg+xml',
      },
    },
  };
}

function artifactNode(
  element: HtmlElement,
  context: ProjectionContext,
  extra: Record<string, unknown> = {},
  countAsUnsupportedWidget = true
): TipTapNode {
  if (countAsUnsupportedWidget) {
    context.unsupportedWidgetCount += 1;
    addWarning(context, WARNING.unsupportedWidget);
  }
  const artifactIndex = ++context.artifactIndex;
  const widgetType = requiredProviderText(
    String(
      extra.artifactType ??
        element.attrs['data-widget-type'] ??
        element.attrs['data-benchling-widget'] ??
        element.tag
    ),
    'Notebook widget type'
  );
  const refId = `source-artifact-${sha256(`${context.source.stableId}:${artifactIndex}`).slice(0, 20)}`;
  const name = requiredProviderText(
    (typeof extra.name === 'string' && extra.name) ||
      element.attrs['aria-label'] ||
      element.attrs.title ||
      `Unsupported Benchling ${widgetType}`,
    'Notebook widget name'
  );
  const sourceWidgetId = optionalProviderText(element.attrs['data-widget-id']);
  const persistedSourceRef =
    typeof extra.sourceRef === 'string'
      ? safeLink(extra.sourceRef, context.sourceBaseUrl)
      : extra.sourceRef === null
        ? null
        : undefined;
  return {
    type: 'embed',
    attrs: {
      type: 'source-artifact',
      refId,
      data: {
        name,
        artifactType: widgetType,
        sourceTag: requiredProviderText(element.tag, 'Notebook source tag'),
        sourceWidgetId,
        textPreview: collapsedText(element).slice(0, 500),
        sourceObjectId: context.persistedStableSourceId,
        ...(persistedSourceRef !== undefined ? { sourceRef: persistedSourceRef } : {}),
      },
    },
  };
}

function isArtifactWidget(element: HtmlElement): boolean {
  if (isIgnorableBenchlingUiChrome(element)) return false;
  const className = element.attrs.class?.toLowerCase() ?? '';
  return (
    ARTIFACT_TAGS.has(element.tag) ||
    Boolean(element.attrs['data-widget-type']) ||
    Boolean(element.attrs['data-benchling-widget']) ||
    /(?:^|\s)(?:benchling-)?widget(?:\s|$)/.test(className)
  );
}

function isBenchlingLinkedFilePreview(element: HtmlElement): boolean {
  return (
    element.attrs['data-test-component'] === 'NoteDropTarget' &&
    element.attrs['data-test-element'] === 'noteLinkedFilePreview'
  );
}

function isBenchlingEmbeddedEntryPreview(element: HtmlElement): boolean {
  return isBenchlingLinkedFilePreview(element) && hasClassToken(element, 'note-entry');
}

function hasProjectedArtifactDescendant(element: HtmlElement): boolean {
  return element.children.some(
    (child) =>
      child.kind === 'element' &&
      (isArtifactWidget(child) ||
        isBenchlingLinkedFilePreview(child) ||
        hasProjectedArtifactDescendant(child))
  );
}

function projectNestedArtifactWidgets(
  element: HtmlElement,
  context: ProjectionContext
): TipTapNode[] {
  const projected: TipTapNode[] = [];
  const visit = (children: HtmlNode[]): void => {
    for (const child of children) {
      if (child.kind !== 'element' || isIgnorableBenchlingUiChrome(child)) continue;
      if (isArtifactWidget(child)) {
        projected.push(convertArtifactWidget(child, context));
        continue;
      }
      visit(child.children);
    }
  };
  visit(element.children);
  return projected;
}

function isIgnorableBenchlingUiChrome(element: HtmlElement): boolean {
  if (isBenchlingEntryExportMetadata(element) || isBenchlingTableTitleBar(element)) return true;
  if (element.tag !== 'svg') return false;
  const component = element.attrs['data-test-component']?.toLowerCase() ?? '';
  const dataTestId = element.attrs['data-testid']?.toLowerCase() ?? '';
  const dataTestKey = element.attrs['data-test-key']?.trim().toLowerCase() ?? '';
  const ariaHidden = element.attrs['aria-hidden']?.trim().toLowerCase() ?? '';
  const ariaLabel = element.attrs['aria-label']?.trim().toLowerCase() ?? '';
  const isTableToggle =
    hasClassToken(element, 'collapserChevron') ||
    ariaLabel === 'collapse table' ||
    ariaLabel === 'expand table';
  const isDecorativeBenchlingIcon =
    component === 'benchlingicon' &&
    ariaHidden === 'true' &&
    hasClassToken(element, 'svg-inline--fa') &&
    Boolean(element.attrs['data-icon']) &&
    dataTestId.startsWith('benchlingicon-');
  const isInternalLinkBenchlingIcon =
    component === 'benchlingicon' &&
    hasClassToken(element, 'internalLink-icon') &&
    Boolean(dataTestKey) &&
    dataTestId === `benchlingicon-${dataTestKey}`;
  return (
    isDecorativeBenchlingIcon ||
    isInternalLinkBenchlingIcon ||
    (isTableToggle &&
      (component === 'benchlingicon' ||
        hasClassToken(element, 'svg-inline--fa') ||
        hasClassToken(element, 'collapserChevron')))
  );
}

function hasClassToken(element: HtmlElement, token: string): boolean {
  const expected = token.toLowerCase();
  return (element.attrs.class ?? '')
    .split(/\s+/u)
    .some((candidate) => candidate.toLowerCase() === expected);
}

class LocalLinkResolver {
  private readonly bindings: NotebookLocalLinkBinding[];
  private readonly keyToIndexes = new Map<string, Set<number>>();
  private readonly sourceBaseUrl: string;

  constructor(bindings: NotebookLocalLinkBinding[], sourceBaseUrl: string) {
    if (bindings.length > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumLocalLinks) {
      throw new Error('Notebook local links exceed the bounded input limit.');
    }
    this.sourceBaseUrl = sourceBaseUrl;
    this.bindings = validateLocalLinkBindings(bindings);
    this.bindings.forEach((binding, index) => {
      const references = [...binding.sourceRefs, binding.sourceTargetId];
      for (const reference of references) {
        for (const key of localLinkKeys(reference, sourceBaseUrl)) {
          const matches = this.keyToIndexes.get(key) ?? new Set<number>();
          matches.add(index);
          this.keyToIndexes.set(key, matches);
        }
      }
    });
  }

  resolve(sourceRef: string): NotebookLocalLinkBinding | null {
    if (this.bindings.length === 0) return null;
    for (const key of localLinkKeys(sourceRef, this.sourceBaseUrl)) {
      const indexes = this.keyToIndexes.get(key);
      if (indexes?.size !== 1) continue;
      return this.bindings[[...indexes][0]];
    }
    return null;
  }
}

type LocalLinkReferenceBudget = {
  references: number;
  bytes: number;
};

function validateLocalLinkBindings(
  bindings: NotebookLocalLinkBinding[]
): NotebookLocalLinkBinding[] {
  const budget: LocalLinkReferenceBudget = { references: 0, bytes: 0 };
  return bindings.map((binding) => validateLocalLinkBinding(binding, budget));
}

function validateLocalLinkBinding(
  binding: NotebookLocalLinkBinding,
  budget: LocalLinkReferenceBudget
): NotebookLocalLinkBinding {
  const relationshipId = requiredProviderText(binding.relationshipId, 'Local relationship ID');
  const relationType = requiredProviderText(binding.relationType, 'Local relationship type');
  const sourceTargetId = requiredProviderText(binding.sourceTargetId, 'Local source target ID');
  const destinationTargetId = requiredProviderText(
    binding.destinationTargetId,
    'Local destination target ID'
  );
  if (!Array.isArray(binding.sourceRefs))
    throw new Error('Local link sourceRefs must be an array.');
  if (binding.sourceRefs.length > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumSourceRefsPerLocalLink) {
    throw new Error('Notebook local link source references exceed the bounded input limit.');
  }
  reserveLocalLinkReference(budget, sourceTargetId);
  const sourceRefs: string[] = [];
  const observedSourceRefs = new Set<string>();
  for (const value of binding.sourceRefs) {
    const sourceRef = requiredPrivateMatcherText(value, 'Local link source reference');
    reserveLocalLinkReference(budget, sourceRef);
    if (!observedSourceRefs.has(sourceRef)) {
      observedSourceRefs.add(sourceRef);
      sourceRefs.push(sourceRef);
    }
  }
  return { relationshipId, relationType, sourceTargetId, destinationTargetId, sourceRefs };
}

function reserveLocalLinkReference(budget: LocalLinkReferenceBudget, value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  const nextReferences = budget.references + 1;
  const nextBytes = budget.bytes + bytes;
  if (nextReferences > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTotalLocalLinkReferences) {
    throw new Error(
      'Notebook local links exceed the bounded aggregate reference-count input limit.'
    );
  }
  if (nextBytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTotalLocalLinkReferenceBytes) {
    throw new Error(
      'Notebook local links exceed the bounded aggregate reference-byte input limit.'
    );
  }
  budget.references = nextReferences;
  budget.bytes = nextBytes;
}

function localLinkKeys(value: string, sourceBaseUrl: string): string[] {
  const trimmed = decodeEntities(String(value ?? '')).trim();
  if (!trimmed) return [];
  const keys = new Set<string>();
  addLocalLinkKey(keys, `raw:${trimmed}`);

  const directObjectId = normalizeExactLocalLinkObjectId(trimmed);
  if (directObjectId) addLocalLinkKey(keys, `object:${directObjectId}`);

  if (!LOCAL_LINK_URL_LIKE.test(trimmed)) return [...keys];

  const resolved = resolveLocalLinkUrl(trimmed, sourceBaseUrl);
  if (!resolved) return [...keys];
  const { parsed, syntheticBase } = resolved;
  parsed.search = '';
  parsed.hash = '';
  if (!syntheticBase) addLocalLinkKey(keys, `url:${parsed.toString()}`);

  const urlObjectId = exactBenchlingObjectId(parsed);
  if (urlObjectId) addLocalLinkKey(keys, `object:${urlObjectId}`);
  return [...keys];
}

function normalizeExactLocalLinkObjectId(value: string): string | null {
  const match = value.match(/^([A-Za-z][A-Za-z0-9]*)_([A-Za-z0-9_]+)$/u);
  if (!match || !LOCAL_LINK_OBJECT_PREFIXES.has(match[1].toLowerCase())) return null;
  return `${match[1].toLowerCase()}_${match[2]}`;
}

function resolveLocalLinkUrl(
  value: string,
  sourceBaseUrl: string
): { parsed: URL; syntheticBase: boolean } | null {
  try {
    if (/^https?:\/\//iu.test(value)) return { parsed: new URL(value), syntheticBase: false };
    if (value.startsWith('//')) {
      return { parsed: new URL(`https:${value}`), syntheticBase: false };
    }

    const sourceBase = new URL(sourceBaseUrl);
    if (sourceBase.protocol === 'http:' || sourceBase.protocol === 'https:') {
      return { parsed: new URL(value, sourceBase), syntheticBase: false };
    }
  } catch {}

  try {
    return {
      parsed: new URL(value, 'https://benchling.com/dnaforge-local/'),
      syntheticBase: true,
    };
  } catch {
    return null;
  }
}

function exactBenchlingObjectId(parsed: URL): string | null {
  try {
    return parseExactlyOneBenchlingObjectUrl(parsed.toString()).objectId;
  } catch {
    if (
      parsed.protocol !== 'https:' ||
      (parsed.hostname !== 'benchling.com' && !parsed.hostname.endsWith('.benchling.com'))
    ) {
      return null;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    const candidates = [...pathname.matchAll(LOCAL_LINK_OBJECT_ID)]
      .map((match) => normalizeExactLocalLinkObjectId(match[1]))
      .filter((candidate): candidate is string => candidate !== null);
    const nonFolderCandidates = candidates.filter(
      (candidate) => !['fld', 'lib', 'src'].includes(candidate.slice(0, candidate.indexOf('_')))
    );
    const chosen = nonFolderCandidates.length > 0 ? nonFolderCandidates : candidates;
    const unique = [...new Set(chosen)];
    return unique.length === 1 ? unique[0] : null;
  }
}

function addLocalLinkKey(keys: Set<string>, value: string): void {
  const key = value.toLowerCase();
  if (!key || keys.has(key)) return;
  keys.add(key);
}

type ValidatedAttachmentBinding = {
  matcherSourceRef: string;
  persisted: NotebookAttachmentBinding;
};

type LinkedFileAttachmentCandidate = {
  index: number;
  normalizedName: string;
  collisionKey: string;
  collisionOrdinal: number;
};

class AttachmentResolver {
  private readonly bindings: ValidatedAttachmentBinding[];
  private readonly keyToIndexes = new Map<string, Set<number>>();
  private readonly usage = new Map<number, number>();
  private readonly linkedFileCandidatesByName = new Map<string, LinkedFileAttachmentCandidate[]>();
  private readonly linkedFileCandidatesByCollisionKey = new Map<
    string,
    LinkedFileAttachmentCandidate[]
  >();
  private readonly linkedFileByIdentifier = new Map<string, number>();
  private readonly claimedLinkedFileIndexes = new Set<number>();

  constructor(
    bindings: NotebookAttachmentBinding[],
    sourceBaseUrl: string,
    sourceName: string,
    stableSourceId: string
  ) {
    if (bindings.length > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumAttachments) {
      throw new Error('Notebook attachments exceed the bounded input limit.');
    }
    this.bindings = bindings.map((binding) => validateAttachmentBinding(binding, sourceBaseUrl));
    const linkedFileCandidates = this.bindings
      .map((binding, index) =>
        linkedFileAttachmentCandidate(binding.persisted, index, sourceName, stableSourceId)
      )
      .filter((candidate): candidate is LinkedFileAttachmentCandidate => candidate !== null)
      .sort(compareLinkedFileAttachmentCandidates);
    for (const candidate of linkedFileCandidates) {
      addLinkedFileCandidate(this.linkedFileCandidatesByName, candidate.normalizedName, candidate);
      addLinkedFileCandidate(
        this.linkedFileCandidatesByCollisionKey,
        candidate.collisionKey,
        candidate
      );
    }
    this.bindings.forEach((binding, index) => {
      for (const key of attachmentKeys(binding.matcherSourceRef)) {
        const matches = this.keyToIndexes.get(key) ?? new Set<number>();
        matches.add(index);
        this.keyToIndexes.set(key, matches);
      }
    });
  }

  resolve(sourceRef: string): NotebookAttachmentBinding | null {
    for (const key of attachmentKeys(sourceRef)) {
      const indexes = this.keyToIndexes.get(key);
      if (indexes?.size !== 1) continue;
      const index = [...indexes][0];
      return this.recordUsage(index);
    }
    return null;
  }

  resolveLinkedFile(identifier: string, displayName: string): NotebookAttachmentBinding | null {
    const normalizedIdentifier = requiredPrivateMatcherText(
      identifier,
      'Benchling linked-file identifier'
    );
    const existing = this.linkedFileByIdentifier.get(normalizedIdentifier);
    if (existing !== undefined) return this.recordUsage(existing);

    const normalizedDisplayName = normalizeLinkedFileName(displayName);
    if (!normalizedDisplayName) return null;
    const exactMatches = (this.linkedFileCandidatesByName.get(normalizedDisplayName) ?? []).filter(
      (candidate) => !this.claimedLinkedFileIndexes.has(candidate.index)
    );
    if (exactMatches.length > 1) return null;
    if (exactMatches.length === 1) {
      return this.claimLinkedFile(normalizedIdentifier, exactMatches[0]);
    }

    const collisionMatches =
      this.linkedFileCandidatesByCollisionKey.get(normalizedDisplayName) ?? [];
    const hasOriginalName = collisionMatches.some(
      (candidate) =>
        candidate.normalizedName === normalizedDisplayName && candidate.collisionOrdinal === 1
    );
    if (!hasOriginalName) return null;
    const unclaimed = collisionMatches.filter(
      (candidate) => !this.claimedLinkedFileIndexes.has(candidate.index)
    );
    if (unclaimed.length === 0) return null;
    const firstOrdinal = unclaimed[0].collisionOrdinal;
    const lowestOrdinal = unclaimed.filter(
      (candidate) => candidate.collisionOrdinal === firstOrdinal
    );
    if (lowestOrdinal.length !== 1) return null;
    return this.claimLinkedFile(normalizedIdentifier, lowestOrdinal[0]);
  }

  references(): NotebookAttachmentReference[] {
    return [...this.usage.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, occurrences]) => ({
        ...this.bindings[index].persisted,
        occurrences,
      }));
  }

  private recordUsage(index: number): NotebookAttachmentBinding {
    this.usage.set(index, (this.usage.get(index) ?? 0) + 1);
    return this.bindings[index].persisted;
  }

  private claimLinkedFile(
    normalizedIdentifier: string,
    candidate: LinkedFileAttachmentCandidate
  ): NotebookAttachmentBinding {
    this.linkedFileByIdentifier.set(normalizedIdentifier, candidate.index);
    this.claimedLinkedFileIndexes.add(candidate.index);
    return this.recordUsage(candidate.index);
  }
}

function addLinkedFileCandidate(
  index: Map<string, LinkedFileAttachmentCandidate[]>,
  key: string,
  candidate: LinkedFileAttachmentCandidate
): void {
  const candidates = index.get(key) ?? [];
  candidates.push(candidate);
  index.set(key, candidates);
}

function linkedFileAttachmentCandidate(
  attachment: NotebookAttachmentBinding,
  index: number,
  sourceName: string,
  stableSourceId: string
): LinkedFileAttachmentCandidate | null {
  const mediaType = attachment.mediaType?.toLowerCase() ?? '';
  if (!mediaType.startsWith('image/') && !/\.(?:png|jpe?g|gif|webp)$/iu.test(attachment.fileName)) {
    return null;
  }
  const leafName = attachment.fileName.replace(/\\/gu, '/').split('/').at(-1) ?? '';
  const stableMarker = `(${stableSourceId})`;
  const markerIndex = leafName.toLowerCase().lastIndexOf(stableMarker.toLowerCase());
  let providerName =
    markerIndex >= 0 ? leafName.slice(markerIndex + stableMarker.length).trim() : leafName;
  if (markerIndex < 0) {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    if (providerName.toLowerCase().startsWith(`${normalizedSourceName} `)) {
      providerName = providerName.slice(sourceName.trim().length).trim();
    }
  }
  const normalizedName = normalizeLinkedFileName(providerName);
  if (!normalizedName) return null;
  const collision = normalizedName.match(/^(.*\S)\s+(\d+)$/u);
  const parsedOrdinal = collision ? Number(collision[2]) : 1;
  const hasCollisionSuffix =
    collision !== null && Number.isSafeInteger(parsedOrdinal) && parsedOrdinal >= 2;
  return {
    index,
    normalizedName,
    collisionKey: hasCollisionSuffix ? collision[1] : normalizedName,
    collisionOrdinal: hasCollisionSuffix ? parsedOrdinal : 1,
  };
}

function normalizeLinkedFileName(value: string): string {
  return decodeEntities(value)
    .normalize('NFC')
    .trim()
    .replace(/\.(?:png|jpe?g|gif|webp)$/iu, '')
    .replace(/[\\/]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function compareLinkedFileAttachmentCandidates(
  left: LinkedFileAttachmentCandidate,
  right: LinkedFileAttachmentCandidate
): number {
  return (
    left.collisionKey.localeCompare(right.collisionKey) ||
    left.collisionOrdinal - right.collisionOrdinal ||
    left.normalizedName.localeCompare(right.normalizedName) ||
    left.index - right.index
  );
}

function validateAttachmentBinding(
  binding: NotebookAttachmentBinding,
  sourceBaseUrl: string
): ValidatedAttachmentBinding {
  const matcherSourceRef = requiredPrivateMatcherText(
    binding.sourceRef,
    'Attachment source reference'
  );
  const hash = requiredText(binding.hash, 'Attachment hash').toLowerCase();
  if (!SHA256.test(hash)) throw new Error('Attachment requires a valid SHA-256 hash.');
  const fileName = requiredProviderText(binding.fileName, 'Attachment file name');
  const workspacePath = binding.workspacePath.replace(/\\/g, '/').trim();
  if (
    !workspacePath ||
    containsControlCharacter(workspacePath) ||
    Buffer.byteLength(workspacePath, 'utf8') >
      NOTEBOOK_HTML_PROJECTION_LIMITS.maximumProviderStringBytes ||
    !isSafeWorkspaceRelativePath(workspacePath)
  ) {
    throw new Error('Attachment requires a safe relative workspace path.');
  }
  const sourceRef = safeLink(matcherSourceRef, sourceBaseUrl) ?? hash;
  const mediaType =
    binding.mediaType === undefined
      ? undefined
      : (optionalProviderText(binding.mediaType) ?? undefined);
  return {
    matcherSourceRef,
    persisted: { sourceRef, hash, fileName, workspacePath, ...(mediaType ? { mediaType } : {}) },
  };
}

function attachmentKeys(value: string): string[] {
  const trimmed = decodeEntities(String(value ?? '')).trim();
  if (!trimmed) return [];
  const withoutFragment = trimmed.split('#')[0];
  const withoutQuery = withoutFragment.split('?')[0].replace(/\\/g, '/');
  const keys = new Set([trimmed, withoutFragment, withoutQuery]);
  try {
    const parsed = new URL(trimmed, 'https://benchling.invalid/');
    keys.add(decodeURIComponent(parsed.pathname));
    keys.add(decodeURIComponent(parsed.pathname).replace(/^\//, ''));
  } catch {}
  return [...keys].filter(Boolean).map((key) => key.toLowerCase());
}

function parseHtml(source: string): HtmlElement {
  const htmlBytes = Buffer.byteLength(source, 'utf8');
  if (htmlBytes === 0 || htmlBytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumHtmlBytes) {
    throw new Error('Notebook HTML exceeds the bounded input limit.');
  }
  const root: HtmlElement = { kind: 'element', tag: 'root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const svgStarts = new WeakMap<HtmlElement, number>();
  const budget: HtmlParseBudget = { nodes: 1, attributes: 0, attributeBytes: 0 };
  let cursor = 0;

  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening < 0) {
      appendText(currentElement(stack, root), source.slice(cursor), budget);
      break;
    }
    appendText(currentElement(stack, root), source.slice(cursor, opening), budget);
    if (source.startsWith('<!--', opening)) {
      const commentEnd = source.indexOf('-->', opening + 4);
      cursor = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    const closing = findTagEnd(source, opening + 1);
    if (closing < 0) {
      appendText(currentElement(stack, root), source.slice(opening), budget);
      break;
    }
    const token = source.slice(opening + 1, closing).trim();
    cursor = closing + 1;
    if (Buffer.byteLength(token, 'utf8') > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTagBytes) {
      throw new Error('Notebook HTML tag exceeds the bounded input limit.');
    }
    if (!token || token.startsWith('!') || token.startsWith('?')) continue;
    if (token.startsWith('/')) {
      const tag = token.slice(1).trim().split(/\s+/)[0].toLowerCase();
      const match = stack.findLastIndex((element) => element.tag === tag);
      if (match > 0) {
        const matched = stack[match];
        const start = svgStarts.get(matched);
        if (start !== undefined) matched.svgSource = source.slice(start, cursor);
        stack.length = match;
      }
      continue;
    }
    const selfClosing = token.endsWith('/');
    const normalized = selfClosing ? token.slice(0, -1).trim() : token;
    const tagMatch = normalized.match(/^([^\s/>]+)/);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();
    if (NON_RENDERED_CONTAINER_TAGS.has(tag)) {
      if (!selfClosing) cursor = skipNonRenderedContainer(source, cursor, tag);
      continue;
    }
    consumeHtmlNode(budget);
    const element: HtmlElement = {
      kind: 'element',
      tag,
      attrs: parseAttributes(normalized.slice(tagMatch[0].length), budget),
      children: [],
    };
    if (tag === 'svg' && !stack.some((parent) => parent.tag === 'svg')) {
      if (selfClosing) element.svgSource = source.slice(opening, cursor);
      else svgStarts.set(element, opening);
    }
    currentElement(stack, root).children.push(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) {
      if (stack.length >= NOTEBOOK_HTML_PROJECTION_LIMITS.maximumDepth + 1) {
        throw new Error('Notebook HTML exceeds the bounded nesting-depth limit.');
      }
      stack.push(element);
    }
  }
  return root;
}

function extractBenchlingEntryExportMetadata(
  root: HtmlElement
): BenchlingEntryExportMetadata | null {
  const metadataRoot = findFirstDescendant(root, isBenchlingEntryExportMetadata);
  if (!metadataRoot) return null;
  const metadata: BenchlingEntryExportMetadata = {
    schema: 'dnaforge.benchling.entry-export-metadata.v1',
  };
  const stack: HtmlElement[] = [metadataRoot];
  while (stack.length > 0) {
    const candidate = stack.pop() as HtmlElement;
    const labelElement = candidate.children.find(
      (child): child is HtmlElement => child.kind === 'element' && child.tag === 'b'
    );
    if (labelElement) {
      const label = collapsedText(labelElement);
      const value = optionalProviderText(collapsedText(candidate).slice(label.length).trim());
      if (value) {
        switch (label.trim().replace(/:$/u, '').toLowerCase()) {
          case 'project':
            metadata.project = value;
            break;
          case 'author':
            metadata.author = value;
            break;
          case 'status':
            metadata.status = value;
            break;
          case 'entry created on':
            metadata.entryCreatedOn = value;
            break;
          case 'entry last modified':
            metadata.entryLastModified = value;
            break;
          case 'export generated on':
            metadata.exportGeneratedOn = value;
            break;
        }
      }
    }
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      const child = candidate.children[index];
      if (child.kind === 'element') stack.push(child);
    }
  }
  return Object.keys(metadata).length > 1 ? metadata : null;
}

function annotateBenchlingTablePresentation(root: HtmlElement): void {
  const stack: HtmlElement[] = [root];
  while (stack.length > 0) {
    const candidate = stack.pop() as HtmlElement;
    if (isBenchlingTableContainer(candidate)) {
      const table = findFirstDescendant(candidate, isBenchlingEditableTable);
      const titleBar = findFirstDescendant(candidate, isBenchlingTableTitleBar);
      const name =
        optionalProviderText(candidate.attrs['aria-label']) ??
        (titleBar ? optionalProviderText(collapsedText(titleBar)) : null);
      if (table && name && !optionalProviderText(table.attrs['data-name'])) {
        table.attrs['data-name'] = name;
      }
    }
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      const child = candidate.children[index];
      if (child.kind === 'element') stack.push(child);
    }
  }
}

function isBenchlingEntryExportMetadata(element: HtmlElement): boolean {
  return (
    element.attrs['data-test-component']?.trim().toLowerCase() === 'entryexportmetadata' &&
    element.attrs['data-test-element']?.trim().toLowerCase() === 'root'
  );
}

function isBenchlingTableContainer(element: HtmlElement): boolean {
  return (
    element.attrs['data-test-component']?.trim().toLowerCase() === 'tableeditable' &&
    element.attrs['data-test-element']?.trim().toLowerCase() === 'plaintable'
  );
}

function isBenchlingTableTitleBar(element: HtmlElement): boolean {
  return (
    element.attrs['data-test-component']?.trim().toLowerCase() === 'tableeditable' &&
    element.attrs['data-test-element']?.trim().toLowerCase() === 'titlebar'
  );
}

function isBenchlingDaySeparator(element: HtmlElement): boolean {
  return (
    element.attrs['data-test-component']?.trim().toLowerCase() === 'dayseparator' &&
    element.attrs['data-test-element']?.trim().toLowerCase() === 'root'
  );
}

function benchlingDaySeparatorText(element: HtmlElement): string | null {
  const date = findFirstDescendant(
    element,
    (candidate) =>
      candidate.attrs['data-test-component']?.trim().toLowerCase() === 'dayseparator' &&
      candidate.attrs['data-test-element']?.trim().toLowerCase() === 'date'
  );
  return date ? optionalProviderText(collapsedText(date)) : null;
}

function findContentRoot(root: HtmlElement): HtmlElement {
  const stack: HtmlElement[] = [root];
  let firstMain: HtmlElement | null = null;
  let firstBody: HtmlElement | null = null;
  while (stack.length > 0) {
    const element = stack.pop() as HtmlElement;
    if (element.tag === 'article' && Boolean(element.attrs['data-benchling-entry-id'])) {
      return element;
    }
    if (firstMain === null && element.tag === 'main') firstMain = element;
    if (firstBody === null && element.tag === 'body') firstBody = element;
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index];
      if (child.kind === 'element') stack.push(child);
    }
  }
  return firstMain ?? firstBody ?? root;
}

function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function parseAttributes(source: string, budget: HtmlParseBudget): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let elementAttributeCount = 0;
  for (const match of source.matchAll(pattern)) {
    elementAttributeCount += 1;
    budget.attributes += 1;
    if (
      elementAttributeCount > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumAttributesPerElement ||
      budget.attributes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTotalAttributes
    ) {
      throw new Error('Notebook HTML exceeds the bounded attribute-count limit.');
    }
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    const valueBytes = Buffer.byteLength(value, 'utf8');
    budget.attributeBytes += valueBytes;
    if (
      valueBytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumAttributeValueBytes ||
      budget.attributeBytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumTotalAttributeBytes
    ) {
      throw new Error('Notebook HTML exceeds the bounded attribute-size limit.');
    }
    attributes[match[1].toLowerCase()] = replaceControlCharacters(value);
  }
  return attributes;
}

function appendText(parent: HtmlElement, text: string, budget: HtmlParseBudget): void {
  if (text) {
    const value = replaceNonWhitespaceControlCharacters(decodeEntities(text));
    if (
      Buffer.byteLength(value, 'utf8') > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumProviderStringBytes
    ) {
      throw new Error('Notebook text node exceeds the bounded string limit.');
    }
    consumeHtmlNode(budget);
    parent.children.push({
      kind: 'text',
      value,
    });
  }
}

function consumeHtmlNode(budget: HtmlParseBudget): void {
  budget.nodes += 1;
  if (budget.nodes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumNodes) {
    throw new Error('Notebook HTML exceeds the bounded node-count limit.');
  }
}

function skipNonRenderedContainer(source: string, cursor: number, tag: string): number {
  let depth = 1;
  let position = cursor;
  while (position < source.length) {
    const opening = source.indexOf('<', position);
    if (opening < 0) return source.length;
    const closing = findTagEnd(source, opening + 1);
    if (closing < 0) return source.length;
    const token = source.slice(opening + 1, closing).trim();
    const closingTag = token.startsWith('/');
    const normalized = closingTag ? token.slice(1).trim() : token;
    const tokenTag = normalized.match(/^([^\s/>]+)/)?.[1]?.toLowerCase();
    if (tokenTag === tag) {
      if (closingTag) depth -= 1;
      else if (!token.endsWith('/')) depth += 1;
      if (depth === 0) return closing + 1;
    }
    position = closing + 1;
  }
  return source.length;
}

function currentElement(stack: HtmlElement[], fallback: HtmlElement): HtmlElement {
  return stack[stack.length - 1] ?? fallback;
}

function findFirstDescendant(
  element: HtmlElement,
  predicate: (candidate: HtmlElement) => boolean
): HtmlElement | null {
  const stack: HtmlElement[] = [];
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    const child = element.children[index];
    if (child.kind === 'element') stack.push(child);
  }
  while (stack.length > 0) {
    const candidate = stack.pop() as HtmlElement;
    if (predicate(candidate)) return candidate;
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      const child = candidate.children[index];
      if (child.kind === 'element') stack.push(child);
    }
  }
  return null;
}

function findMatchingDescendants(
  element: HtmlElement,
  predicate: (candidate: HtmlElement) => boolean,
  maximumMatches: number
): HtmlElement[] {
  const matches: HtmlElement[] = [];
  const stack: HtmlElement[] = [];
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    const child = element.children[index];
    if (child.kind === 'element') stack.push(child);
  }
  while (stack.length > 0 && matches.length < maximumMatches) {
    const candidate = stack.pop() as HtmlElement;
    if (predicate(candidate)) matches.push(candidate);
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      const child = candidate.children[index];
      if (child.kind === 'element') stack.push(child);
    }
  }
  return matches;
}

function directTableCells(row: HtmlElement): HtmlElement[] {
  return row.children.filter(
    (child): child is HtmlElement =>
      child.kind === 'element' && (child.tag === 'td' || child.tag === 'th')
  );
}

function isBenchlingEditableTable(table: HtmlElement): boolean {
  return (
    table.attrs['data-test-component']?.trim().toLowerCase() === 'tableeditable' &&
    table.attrs['data-test-element']?.trim().toLowerCase() === 'table'
  );
}

function isBenchlingAxisCell(cell: HtmlElement): boolean {
  return (
    hasClassToken(cell, 'mediocre-tableEditable-axisCell') ||
    ['columnheader', 'rowheader'].includes(
      cell.attrs['data-test-element']?.trim().toLowerCase() ?? ''
    )
  );
}

function isBenchlingColumnAxisCell(cell: HtmlElement): boolean {
  return (
    hasClassToken(cell, 'mediocre-tableEditable-axisCell--col') ||
    cell.attrs['data-test-element']?.trim().toLowerCase() === 'columnheader' ||
    cell.attrs.role?.trim().toLowerCase() === 'columnheader'
  );
}

type ProjectedTableCellFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  align?: 'left' | 'center' | 'right';
  textColor?: string;
  bgColor?: string;
  wrap?: boolean;
};

function tableCellFormat(
  cell: HtmlElement,
  isBenchlingEditable: boolean
): ProjectedTableCellFormat | null {
  const style = inlineStyleDeclarations(cell.attrs.style);
  const format: ProjectedTableCellFormat = {};
  if (isBenchlingEditable) format.wrap = true;
  if (
    hasClassToken(cell, 'is-bold') ||
    style['font-weight'] === 'bold' ||
    /^[6-9]00$/u.test(style['font-weight'] ?? '')
  ) {
    format.bold = true;
  }
  if (hasClassToken(cell, 'is-italic') || style['font-style'] === 'italic') format.italic = true;
  const textDecoration = `${style['text-decoration'] ?? ''} ${
    style['text-decoration-line'] ?? ''
  }`.toLowerCase();
  if (
    hasClassToken(cell, 'is-underline') ||
    hasClassToken(cell, 'is-underlined') ||
    /(?:^|\s)underline(?:\s|$)/u.test(textDecoration)
  ) {
    format.underline = true;
  }
  if (
    hasClassToken(cell, 'is-strikethrough') ||
    /(?:^|\s)line-through(?:\s|$)/u.test(textDecoration)
  ) {
    format.strikethrough = true;
  }
  if (hasClassToken(cell, 'is-alignRight') || style['text-align'] === 'right') {
    format.align = 'right';
  } else if (hasClassToken(cell, 'is-alignCenter') || style['text-align'] === 'center') {
    format.align = 'center';
  } else if (hasClassToken(cell, 'is-alignLeft') || style['text-align'] === 'left') {
    format.align = 'left';
  }
  const textColor = safeTableColor(style.color);
  const bgColor = safeTableColor(style['background-color']);
  if (textColor) format.textColor = textColor;
  if (bgColor) format.bgColor = bgColor;
  return Object.keys(format).length > 0 ? format : null;
}

function withTableCellFormat<T extends Record<string, unknown>>(
  cell: T,
  format: ProjectedTableCellFormat | null
): T & { format?: ProjectedTableCellFormat } {
  return format ? { ...cell, format } : cell;
}

type ProjectedTableCellReference =
  | {
      kind: 'native-entity';
      entityId: string;
    }
  | {
      kind: 'external-url';
      href: string;
    };

function tableCellReference(
  cell: HtmlElement,
  context: ProjectionContext
): ProjectedTableCellReference | null {
  const anchors: HtmlElement[] = [];
  const stack: HtmlNode[] = [...cell.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if (node.kind === 'text') continue;
    if (node.tag === 'a' && node.attrs.href?.trim()) anchors.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  if (anchors.length !== 1) return null;
  if (tableCellText(cell) !== collapsedText(anchors[0])) return null;
  const href = anchors[0].attrs.href;
  const localLink = context.localLinks.resolve(href);
  if (localLink) {
    reserveIncrementalLocalLinkMark(context, localLink);
    return {
      kind: 'native-entity',
      entityId: localLink.destinationTargetId,
    };
  }
  const safeHref = safeLink(href, context.sourceBaseUrl);
  if (!safeHref) {
    addWarning(context, WARNING.unsafeLink);
    return null;
  }
  if (!/^https?:/iu.test(safeHref)) return null;
  return { kind: 'external-url', href: safeHref };
}

function withTableCellReference<T extends Record<string, unknown>>(
  cell: T,
  reference: ProjectedTableCellReference | null
): T & { reference?: ProjectedTableCellReference } {
  return reference ? { ...cell, reference } : cell;
}

function inlineStyleDeclarations(value: string | undefined): Record<string, string> {
  const declarations: Record<string, string> = Object.create(null);
  for (const declaration of (value ?? '').split(';')) {
    const separator = declaration.indexOf(':');
    if (separator <= 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (property && propertyValue) declarations[property] = propertyValue;
  }
  return declarations;
}

function safeTableColor(value: string | undefined): string | null {
  const color = value?.trim();
  if (!color) return null;
  if (/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(color)) return color;
  if (color.toLowerCase() === 'transparent') return color;
  const rgb = color.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/iu
  );
  if (!rgb) return null;
  if (rgb.slice(1, 4).some((channel) => Number(channel) > 255)) return null;
  const isRgba = color.toLowerCase().startsWith('rgba(');
  if (isRgba !== Boolean(rgb[4])) return null;
  return color;
}

function safeInlineColor(value: string | undefined): string | null {
  const color = safeTableColor(value);
  if (!color) return null;
  const normalized = color.toLowerCase();
  if (normalized === 'transparent') return null;
  if (/^#[a-f0-9]{3}0$/iu.test(normalized) || /^#[a-f0-9]{6}00$/iu.test(normalized)) {
    return null;
  }
  if (/^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*0(?:\.0+)?\s*\)$/iu.test(normalized)) {
    return null;
  }
  return color;
}

function tableColumnWidths(
  table: HtmlElement,
  isBenchlingEditable: boolean
): Record<number, number> {
  const colgroup = findFirstDescendant(table, (element) => element.tag === 'colgroup');
  if (!colgroup) return {};
  const allColumns = colgroup.children.filter(
    (child): child is HtmlElement => child.kind === 'element' && child.tag === 'col'
  );
  const providerColumns = isBenchlingEditable
    ? allColumns.filter(
        (column) =>
          column.attrs['data-test-element']?.trim().toLowerCase() === 'column' ||
          Boolean(column.attrs['data-id']?.trim())
      )
    : allColumns;
  const columns =
    isBenchlingEditable && providerColumns.length === 0 ? allColumns.slice(1) : providerColumns;
  const widths: Record<number, number> = {};
  columns.forEach((column, index) => {
    const width = inlineStyleDeclarations(column.attrs.style).width;
    const match = width?.match(/^(\d+(?:\.\d+)?)px$/u);
    if (!match) return;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10_000) widths[index] = parsed;
  });
  return widths;
}

function padStrings(values: string[], length: number): string[] {
  const padded = values.slice(0, length);
  while (padded.length < length) padded.push('');
  return padded;
}

function collectTableRows(table: HtmlElement): HtmlElement[] {
  const rows: HtmlElement[] = [];
  const stack: HtmlElement[] = [];
  for (let index = table.children.length - 1; index >= 0; index -= 1) {
    const child = table.children[index];
    if (child.kind === 'element') stack.push(child);
  }
  while (stack.length > 0) {
    const candidate = stack.pop() as HtmlElement;
    if (candidate.tag === 'table') continue;
    if (candidate.tag === 'tr') rows.push(candidate);
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      const child = candidate.children[index];
      if (child.kind === 'element') stack.push(child);
    }
  }
  return rows;
}

function rawText(element: HtmlElement): string {
  const fragments: string[] = [];
  const stack: HtmlNode[] = [...element.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if (node.kind === 'text') {
      fragments.push(node.value);
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return sanitizeLiteralUrlLikeTokens(fragments.join(''));
}

function collapsedText(element: HtmlElement): string {
  return rawText(element).replace(/\s+/g, ' ').trim();
}

function tableCellText(cell: HtmlElement): string {
  if (!hasClassToken(cell, 'mediocre-tableEditable-axisCell')) {
    return collapsedText(cell);
  }
  const fragments: string[] = [];
  const stack: HtmlNode[] = [...cell.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if (node.kind === 'text') {
      fragments.push(node.value);
      continue;
    }
    if (hasClassToken(node, 'invisible')) continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return sanitizeLiteralUrlLikeTokens(fragments.join('')).replace(/\s+/g, ' ').trim();
}

function normalizeInline(content: TipTapNode[]): TipTapNode[] {
  const normalized: TipTapNode[] = [];
  let pendingText: TipTapNode | null = null;
  let pendingFragments: string[] = [];
  const flushPendingText = () => {
    if (pendingText === null) return;
    const text = pendingFragments.join('');
    if (text) normalized.push({ ...pendingText, text });
    pendingText = null;
    pendingFragments = [];
  };
  for (const node of content) {
    if (node.type === 'text') {
      const text = node.text ?? '';
      if (!text) continue;
      if (pendingText !== null && sameMarkLists(pendingText.marks, node.marks)) {
        pendingFragments.push(text);
      } else {
        flushPendingText();
        pendingText = node;
        pendingFragments = [text];
      }
    } else {
      flushPendingText();
      normalized.push(node);
    }
  }
  flushPendingText();
  const firstText = normalized.find((node) => node.type === 'text');
  if (firstText?.text) firstText.text = firstText.text.replace(/^\s+/, '');
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const lastText = normalized[index];
    if (lastText.type !== 'text') continue;
    if (lastText.text) lastText.text = lastText.text.replace(/\s+$/, '');
    break;
  }
  return normalized.filter((node) => node.type !== 'text' || Boolean(node.text));
}

function sanitizeTipTapTextRuns(content: TipTapNode[]): TipTapNode[] {
  const pending: TipTapNode[][] = [content];
  while (pending.length > 0) {
    const nodes = pending.pop() as TipTapNode[];
    for (const node of nodes) {
      if (node.content) pending.push(node.content);
    }

    const rebuilt: TipTapNode[] = [];
    for (let index = 0; index < nodes.length; ) {
      if (nodes[index].type !== 'text') {
        rebuilt.push(nodes[index]);
        index += 1;
        continue;
      }
      const run: TipTapNode[] = [];
      while (index < nodes.length && nodes[index].type === 'text') {
        run.push(nodes[index]);
        index += 1;
      }
      for (const node of sanitizeTextNodeRun(run)) rebuilt.push(node);
    }
    nodes.length = 0;
    for (const node of rebuilt) nodes.push(node);
  }
  return content;
}

function sanitizeTextNodeRun(nodes: TipTapNode[]): TipTapNode[] {
  const joined = nodes.map((node) => node.text ?? '').join('');
  LITERAL_URL_LIKE.lastIndex = 0;
  const offsets: number[] = [];
  let offset = 0;
  for (const node of nodes) {
    offsets.push(offset);
    offset += (node.text ?? '').length;
  }

  const output: TipTapNode[] = [];
  let cursor = 0;
  let sourceNodeIndex = 0;
  let matched = false;
  const appendOriginalRange = (end: number) => {
    while (cursor < end && sourceNodeIndex < nodes.length) {
      const source = nodes[sourceNodeIndex];
      const sourceText = source.text ?? '';
      const sourceStart = offsets[sourceNodeIndex];
      const from = Math.max(cursor - sourceStart, 0);
      const to = Math.min(end - sourceStart, sourceText.length);
      if (to > from) output.push({ ...source, text: sourceText.slice(from, to) });
      cursor = sourceStart + to;
      if (to >= sourceText.length) sourceNodeIndex += 1;
    }
  };
  const skipOriginalRange = (end: number): TipTapNode[] => {
    const coveredNodes: TipTapNode[] = [];
    while (cursor < end && sourceNodeIndex < nodes.length) {
      const source = nodes[sourceNodeIndex];
      const sourceText = source.text ?? '';
      const sourceStart = offsets[sourceNodeIndex];
      const to = Math.min(end - sourceStart, sourceText.length);
      coveredNodes.push(source);
      cursor = sourceStart + to;
      if (to >= sourceText.length) sourceNodeIndex += 1;
    }
    return coveredNodes;
  };

  for (const match of joined.matchAll(LITERAL_URL_LIKE)) {
    matched = true;
    const matchStart = match.index ?? 0;
    const candidate = match[0];
    const matchEnd = matchStart + candidate.length;
    const sanitized = sanitizeLiteralUrlLikeCandidate(candidate);
    appendOriginalRange(matchStart);
    if (sanitized === candidate) {
      appendOriginalRange(matchEnd);
      continue;
    }
    const coveredNodes = skipOriginalRange(matchEnd);
    const marks = commonMarks(coveredNodes);
    output.push({
      type: 'text',
      text: sanitized,
      ...(marks.length > 0 ? { marks } : {}),
    });
  }
  if (!matched) return nodes;
  appendOriginalRange(joined.length);
  return coalesceTextNodeRun(output);
}

function coalesceTextNodeRun(nodes: TipTapNode[]): TipTapNode[] {
  const output: TipTapNode[] = [];
  let pending: TipTapNode | null = null;
  let pendingFragments: string[] = [];
  const flush = () => {
    if (pending !== null) output.push({ ...pending, text: pendingFragments.join('') });
    pending = null;
    pendingFragments = [];
  };
  for (const node of nodes) {
    if (pending !== null && sameMarkLists(pending.marks, node.marks)) {
      pendingFragments.push(node.text ?? '');
      continue;
    }
    flush();
    pending = node;
    pendingFragments = [node.text ?? ''];
  }
  flush();
  return output;
}

function commonMarks(nodes: readonly TipTapNode[]): TipTapMark[] {
  if (nodes.length === 0) return [];
  let common = [...((nodes[0].marks ?? []) as TipTapMark[])];
  for (let index = 1; index < nodes.length && common.length > 0; index += 1) {
    const observed = (nodes[index].marks ?? []) as TipTapMark[];
    common = common.filter((candidate) => observed.some((mark) => sameMark(candidate, mark)));
  }
  return common.sort((left, right) => left.type.localeCompare(right.type));
}

function stableMarks(marks: TipTapMark[]): TipTapMark[] | undefined {
  if (marks.length === 0) return undefined;
  const byType = new Map<string, TipTapMark>();
  for (const mark of marks) byType.set(mark.type, mark);
  return [...byType.values()].sort((left, right) => left.type.localeCompare(right.type));
}

function sameMarkLists(
  left: readonly TipTapMark[] | undefined,
  right: readonly TipTapMark[] | undefined
): boolean {
  const leftMarks = left ?? [];
  const rightMarks = right ?? [];
  if (leftMarks.length !== rightMarks.length) return false;
  return leftMarks.every((mark, index) => sameMark(mark, rightMarks[index]));
}

function sameMark(left: TipTapMark, right: TipTapMark): boolean {
  if (left === right) return true;
  if (left.type !== right.type) return false;
  if (left.attrs === right.attrs) return true;
  return left.attrs === undefined && right.attrs === undefined;
}

function inlineMarkType(tag: string): string | null {
  if (tag === 'strong' || tag === 'b') return 'bold';
  if (tag === 'em' || tag === 'i') return 'italic';
  if (tag === 'u') return 'underline';
  if (tag === 's' || tag === 'strike' || tag === 'del') return 'strike';
  if (tag === 'code') return 'code';
  if (tag === 'sub') return 'subscript';
  if (tag === 'sup') return 'superscript';
  return null;
}

function safeLink(value: string, sourceBaseUrl: string): string | null {
  const trimmed = decodeEntities(value).trim();
  if (!trimmed || containsControlCharacter(trimmed)) return null;
  if (trimmed.startsWith('#')) return null;
  try {
    const candidate = /^(?:https?:|[\\/]{2})/i.test(trimmed)
      ? normalizeLiteralUrlLikeToken(trimmed)
      : trimmed;
    const parsed = new URL(candidate, sourceBaseUrl);
    if (
      !SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol) ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return null;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return sanitizeBenchlingMigrationExternalHttpUrl(parsed.toString());
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeLiteralUrlLikeTokens(value: string): string {
  return value.replace(LITERAL_URL_LIKE, sanitizeLiteralUrlLikeCandidate);
}

function sanitizeLiteralUrlLikeCandidate(candidate: string): string {
  const { url, trailing } = splitTrailingUrlPunctuation(candidate);
  const sanitized = safeAbsoluteHttpUrl(normalizeLiteralUrlLikeToken(url));
  return `${sanitized ?? '[unsafe URL removed]'}${trailing}`;
}

function normalizeLiteralUrlLikeToken(value: string): string {
  const slashNormalized = value.replace(/\\/g, '/');
  if (slashNormalized.startsWith('//')) return `https:${slashNormalized}`;
  const scheme = slashNormalized.match(/^(https?):/i);
  if (!scheme) return slashNormalized;
  return `${scheme[1].toLowerCase()}://${slashNormalized
    .slice(scheme[0].length)
    .replace(/^\/+/, '')}`;
}

function safeAbsoluteHttpUrl(value: string): string | null {
  return sanitizeBenchlingMigrationExternalHttpUrl(value);
}

function splitTrailingUrlPunctuation(value: string): { url: string; trailing: string } {
  let boundary = value.length;
  while (boundary > 0 && isTrailingUrlPunctuation(value[boundary - 1])) boundary -= 1;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < boundary; index += 1) {
    switch (value[index]) {
      case '(':
        parentheses += 1;
        break;
      case ')':
        parentheses -= 1;
        break;
      case '[':
        brackets += 1;
        break;
      case ']':
        brackets -= 1;
        break;
      case '{':
        braces += 1;
        break;
      case '}':
        braces -= 1;
        break;
    }
  }
  while (boundary > 0) {
    const character = value[boundary - 1];
    if (character === ')' && parentheses < 0) {
      parentheses += 1;
      boundary -= 1;
    } else if (character === ']' && brackets < 0) {
      brackets += 1;
      boundary -= 1;
    } else if (character === '}' && braces < 0) {
      braces += 1;
      boundary -= 1;
    } else {
      break;
    }
  }
  return { url: value.slice(0, boundary), trailing: value.slice(boundary) };
}

function isTrailingUrlPunctuation(value: string): boolean {
  return (
    value === '.' ||
    value === ',' ||
    value === ';' ||
    value === ':' ||
    value === '!' ||
    value === '?'
  );
}

function safeSourceUrl(value: string): string {
  const sourceUrl = requiredText(value, 'Source URL');
  if (
    containsControlCharacter(sourceUrl) ||
    Buffer.byteLength(sourceUrl, 'utf8') >
      NOTEBOOK_HTML_PROJECTION_LIMITS.maximumProviderStringBytes
  ) {
    throw new Error('Notebook source URL exceeds the bounded string limit.');
  }
  if (isBenchlingLocalExportProvenanceUrn(sourceUrl)) return sourceUrl;
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'https:') throw new Error('Notebook source URL must use HTTPS.');
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString();
}

function removeDuplicateTitle(content: TipTapNode[], title: string): TipTapNode[] {
  const [first, ...rest] = content;
  if (
    first?.type === 'heading' &&
    first.attrs?.level === 1 &&
    tipTapInlineText(first.content).trim() === title.trim()
  ) {
    return rest;
  }
  return content;
}

function tipTapInlineText(content: TipTapNode[] | undefined): string {
  const fragments: string[] = [];
  const stack = [...(content ?? [])].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as TipTapNode;
    if (node.text) fragments.push(node.text);
    if (node.content) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        stack.push(node.content[index]);
      }
    }
  }
  return fragments.join('');
}

function notebookHtml(content: unknown): string {
  if (typeof content === 'string' && content.trim()) return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const html = (content as Record<string, unknown>).html;
    if (typeof html === 'string' && html.trim()) return html;
  }
  throw new Error('Notebook content requires non-empty exported HTML.');
}

function listItemContent(content: TipTapNode[]): TipTapNode[] {
  return content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content];
}

function ensureDocumentContent(content: TipTapNode[]): TipTapNode[] {
  return content.length > 0 ? content : [{ type: 'paragraph' }];
}

function formulaAttribute(cell: HtmlElement): string | null {
  for (const key of ['data-formula', 'data-cell-formula', 'data-benchling-formula', 'formula']) {
    const value = cell.attrs[key]?.trim();
    if (value) return value.startsWith('=') ? value : `=${value}`;
  }
  return null;
}

function numericCell(value: string): Record<string, unknown> {
  const number = numericValue(value);
  return number === null ? { type: 'text', value } : { type: 'number', value };
}

function numericValue(value: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stripQuotedStrings(value: string): string {
  return value.replace(/"(?:[^"]|"")*"/g, '');
}

function balancedParentheses(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

function cellAddress(row: number, column: number): string {
  let label = '';
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return `${label}${row + 1}`;
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
    if (token.startsWith('#x') || token.startsWith('#X')) {
      const code = Number.parseInt(token.slice(2), 16);
      return validCodePoint(code) ? String.fromCodePoint(code) : entity;
    }
    if (token.startsWith('#')) {
      const code = Number.parseInt(token.slice(1), 10);
      return validCodePoint(code) ? String.fromCodePoint(code) : entity;
    }
    return named[token.toLowerCase()] ?? entity;
  });
}

function validCodePoint(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
  );
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function safeWorkspaceRelativePath(value: unknown, label: string): string {
  const path = requiredText(value, label).replace(/\\/g, '/');
  if (!isSafeWorkspaceRelativePath(path)) {
    throw new Error(`${label} must be a safe workspace-relative path.`);
  }
  return path;
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredText(value, label);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function optionalTimestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredTimestamp(value, 'Source timestamp');
}

function requiredProviderText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  if (
    Buffer.byteLength(value, 'utf8') > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumProviderStringBytes
  ) {
    throw new Error(`${label} exceeds the bounded string limit.`);
  }
  const sanitized = sanitizeLiteralUrlLikeTokens(replaceControlCharacters(value)).trim();
  if (!sanitized) throw new Error(`${label} is required.`);
  if (
    Buffer.byteLength(sanitized, 'utf8') >
    NOTEBOOK_HTML_PROJECTION_LIMITS.maximumProviderStringBytes
  ) {
    throw new Error(`${label} exceeds the bounded string limit.`);
  }
  return sanitized;
}

function optionalProviderText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requiredProviderText(value, 'Notebook provider field');
}

function requiredPrivateMatcherText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const trimmed = value.trim();
  if (
    containsControlCharacter(trimmed) ||
    Buffer.byteLength(trimmed, 'utf8') > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumProviderStringBytes
  ) {
    throw new Error(`${label} exceeds the bounded private matcher limit.`);
  }
  return trimmed;
}

function addWarning(context: ProjectionContext, warning: string): void {
  if (context.warnings.length >= NOTEBOOK_HTML_PROJECTION_LIMITS.maximumWarnings) {
    throw new Error('Notebook projection exceeds the bounded warning limit.');
  }
  context.warnings.push(warning);
}

function addWarningOnce(context: ProjectionContext, warning: string): void {
  if (!context.warnings.includes(warning)) addWarning(context, warning);
}

function addFormula(context: ProjectionContext, formula: NotebookFormulaCompatibility): void {
  if (context.formulas.length >= NOTEBOOK_HTML_PROJECTION_LIMITS.maximumFormulas) {
    throw new Error('Notebook projection exceeds the bounded formula limit.');
  }
  context.formulas.push(formula);
}

function reserveIncrementalTextProjection(
  context: ProjectionContext,
  text: string,
  marks: readonly TipTapMark[] | undefined
): void {
  const estimatedBytes =
    24 +
    serializedJsonStringBytes(text) +
    (marks === undefined ? 0 : 9 + estimateBoundedJsonBytes(marks));
  reserveIncrementalProjectionBytes(context, estimatedBytes);
}

function reserveIncrementalLocalLinkMark(
  context: ProjectionContext,
  localLink: NotebookLocalLinkBinding
): void {
  const encodedDestinationUpperBound = Buffer.byteLength(localLink.destinationTargetId, 'utf8') * 3;
  const estimatedBytes =
    192 +
    encodedDestinationUpperBound +
    serializedJsonStringBytes(localLink.relationshipId) +
    serializedJsonStringBytes(localLink.relationType) +
    serializedJsonStringBytes(localLink.sourceTargetId) +
    serializedJsonStringBytes(localLink.destinationTargetId);
  reserveIncrementalProjectionBytes(context, estimatedBytes);
}

function requiredNativeEntityHref(entityId: string): string {
  const href = nativeEntityReferenceHref(entityId);
  if (!href) throw new Error('Notebook local link has an invalid native destination identity.');
  return href;
}

function reserveIncrementalProjectionBytes(
  context: ProjectionContext,
  estimatedBytes: number
): void {
  const nextBytes = context.incrementalProjectionBytes + estimatedBytes;
  if (nextBytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumIncrementalProjectionBytes) {
    throw new Error(
      'Notebook projection exceeds the bounded output limit during incremental construction.'
    );
  }
  context.incrementalProjectionBytes = nextBytes;
}

function estimateBoundedJsonBytes(value: unknown): number {
  const pending: unknown[] = [value];
  let bytes = 0;
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === null || candidate === undefined) {
      bytes += 4;
    } else if (typeof candidate === 'string') {
      bytes += serializedJsonStringBytes(candidate);
    } else if (typeof candidate === 'number') {
      bytes += 24;
    } else if (typeof candidate === 'boolean') {
      bytes += 5;
    } else if (Array.isArray(candidate)) {
      bytes += 2 + Math.max(candidate.length - 1, 0);
      for (const item of candidate) pending.push(item);
    } else if (typeof candidate === 'object') {
      const entries = Object.entries(candidate as Record<string, unknown>);
      bytes += 2 + Math.max(entries.length - 1, 0);
      for (const [key, item] of entries) {
        bytes += serializedJsonStringBytes(key) + 1;
        pending.push(item);
      }
    } else {
      bytes += 4;
    }
    if (bytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumIncrementalProjectionBytes) {
      return bytes;
    }
  }
  return bytes;
}

function serializedJsonStringBytes(value: string): number {
  let bytes = Buffer.byteLength(value, 'utf8') + 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) {
      bytes += 1;
    } else if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      bytes += 1;
    } else if (code <= 31) {
      bytes += 5;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else bytes += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3;
    }
  }
  return bytes;
}

function assertProjectionOutputBudget(projection: NotebookHtmlProjection): void {
  const bytes = Buffer.byteLength(JSON.stringify(projection), 'utf8');
  if (bytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumOutputBytes) {
    throw new Error('Notebook projection exceeds the bounded output limit.');
  }
}

function safeFileStem(value: string): string {
  const stem = replaceControlCharacters(value.normalize('NFKC'))
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._ ]+|[._ ]+$/g, '')
    .slice(0, 120);
  return stem || `Notebook_${sha256(value).slice(0, 12)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  return replaceSelectedControlCharacters(value, false);
}

function replaceNonWhitespaceControlCharacters(value: string): string {
  return replaceSelectedControlCharacters(value, true);
}

function replaceSelectedControlCharacters(value: string, preserveWhitespace: boolean): string {
  const fragments: string[] = [];
  let lastBoundary = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isWhitespaceControl = code === 9 || code === 10 || code === 13;
    if ((code > 31 && code !== 127) || (preserveWhitespace && isWhitespaceControl)) continue;
    fragments.push(value.slice(lastBoundary, index), '_');
    lastBoundary = index + 1;
  }
  if (fragments.length === 0) return value;
  fragments.push(value.slice(lastBoundary));
  return fragments.join('');
}
