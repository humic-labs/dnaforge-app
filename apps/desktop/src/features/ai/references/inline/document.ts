import type { Link, Root, RootContent, Text } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import {
  decodeInlineReferenceUrl,
  encodeInlineReferenceDeclaration,
  isInlineReferenceLabelValid,
  MAX_INLINE_REFERENCES_PER_MESSAGE,
} from './codec';
import type { InlineReferencePart, InlineTextDocument } from './types';
import type { DBEntityReference } from '../../../../db/entity-references';
import { stripDisplayExtension } from '../../../../utils/fileTypes';
import {
  molecularDocumentReferenceFromData,
  molecularDocumentReferenceLocator,
  molecularDocumentReferenceRecord,
} from '../../../../shared/molecular-document-reference';

interface BuildInlineTextDocumentOptions {
  streaming: boolean;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });

function visit(node: Root | RootContent, visitor: (candidate: RootContent) => void): void {
  if (node.type !== 'root') visitor(node);
  if ('children' in node) {
    for (const child of node.children) visit(child, visitor);
  }
}

function nodeOffsets(node: RootContent): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

function plainLinkLabel(node: Link): string | null {
  if (node.children.length !== 1 || node.children[0].type !== 'text') return null;
  const label = node.children[0].value;
  return isInlineReferenceLabelValid(label) ? label : null;
}

function collectParts(root: Root): InlineReferencePart[] {
  const parts: InlineReferencePart[] = [];
  visit(root, (node) => {
    if (node.type !== 'link' || parts.length >= MAX_INLINE_REFERENCES_PER_MESSAGE) return;
    const label = plainLinkLabel(node);
    const range = nodeOffsets(node);
    const decoded = decodeInlineReferenceUrl(node.url);
    if (!label || !range || !decoded.ok) return;
    parts.push({
      key: `inline-reference-${range.start}-${range.end}`,
      label,
      sourceRange: range,
      declaration: decoded.declaration,
      state: { status: 'pending' },
    });
  });
  return parts;
}

function terminalTextNode(root: Root, sourceLength: number): Text | null {
  let result: Text | null = null;
  visit(root, (node) => {
    if (node.type !== 'text' || node.position?.end.offset !== sourceLength) return;
    if (!result || (node.position.start.offset ?? -1) > (result.position?.start.offset ?? -1)) {
      result = node;
    }
  });
  return result;
}

function escapeReadableLabel(label: string): string {
  return label.replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
}

interface IncompleteTail {
  start: number;
  replacement: string;
}

function incompleteTail(source: string, root: Root): IncompleteTail | null {
  const tail = terminalTextNode(root, source.length);
  const tailStart = tail?.position?.start.offset;
  if (!tail || typeof tailStart !== 'number') return null;

  const rawTail = source.slice(tailStart);
  const match = rawTail.match(/\[([^\r\n]{1,200})\]\(([^\s)]*)$/);
  if (!match || typeof match.index !== 'number' || !isInlineReferenceLabelValid(match[1])) {
    return null;
  }
  const transport = match[2];
  const scheme = 'dnaforge-chat://';
  if (!scheme.startsWith(transport) && !transport.startsWith(scheme)) return null;
  return {
    start: tailStart + match.index,
    replacement: escapeReadableLabel(match[1]),
  };
}

function scrubPrivateTransport(source: string): string {
  return source
    .replace(/\[([^\r\n\]]{1,200})\]\(dnaforge-chat:\/\/[^\s)]*\)/g, (_match, label: string) =>
      escapeReadableLabel(label)
    )
    .replace(/dnaforge-chat:\/\/[^\s`<>"')\]]*/g, 'reference');
}

function projectRenderSource(
  source: string,
  parts: readonly InlineReferencePart[],
  tail: IncompleteTail | null
): { renderSource: string; parts: InlineReferencePart[] } {
  let cursor = 0;
  let result = '';
  const projectedParts: InlineReferencePart[] = [];
  for (const part of [...parts].sort(
    (left, right) => left.sourceRange.start - right.sourceRange.start
  )) {
    result += scrubPrivateTransport(source.slice(cursor, part.sourceRange.start));
    const renderStart = result.length;
    result += source.slice(part.sourceRange.start, part.sourceRange.end);
    const renderEnd = result.length;
    projectedParts.push({
      ...part,
      key: `inline-reference-${renderStart}-${renderEnd}`,
    });
    cursor = part.sourceRange.end;
  }
  if (tail && tail.start >= cursor) {
    result += scrubPrivateTransport(source.slice(cursor, tail.start));
    result += tail.replacement;
  } else {
    result += scrubPrivateTransport(source.slice(cursor));
  }
  return { renderSource: result, parts: projectedParts };
}

function hasPotentialInlineReference(source: string): boolean {
  if (source.includes('dnaforge-chat://')) return true;
  const linkStart = source.lastIndexOf('](');
  if (linkStart < 0) return false;
  const transport = source.slice(linkStart + 2);
  return !/[\s)]/.test(transport) && 'dnaforge-chat://'.startsWith(transport);
}

export function buildInlineTextDocument(
  source: string,
  options: BuildInlineTextDocumentOptions
): InlineTextDocument {
  if (!hasPotentialInlineReference(source)) {
    return { source, renderSource: source, parts: [] };
  }

  const root = markdownParser.parse(source) as Root;
  const parts = collectParts(root);
  const projected = projectRenderSource(
    source,
    parts,
    options.streaming ? incompleteTail(source, root) : null
  );
  return {
    source,
    ...projected,
  };
}

export function reprojectInlineTextDocument(
  document: InlineTextDocument,
  source: string,
  options: BuildInlineTextDocumentOptions
): InlineTextDocument {
  if (document.source === source) return document;
  const statesByDeclaration = new Map<string, InlineReferencePart['state'][]>();
  for (const part of document.parts) {
    const key = encodeInlineReferenceDeclaration(part.declaration);
    const states = statesByDeclaration.get(key) ?? [];
    states.push(part.state);
    statesByDeclaration.set(key, states);
  }
  const projected = buildInlineTextDocument(source, options);
  return {
    ...projected,
    parts: projected.parts.map((part) => {
      const key = encodeInlineReferenceDeclaration(part.declaration);
      const state = statesByDeclaration.get(key)?.shift();
      return state ? { ...part, state } : part;
    }),
  };
}

function bindPersistedMolecularDocumentPart(
  part: InlineReferencePart,
  referenceIds: readonly string[],
  references: ReadonlyMap<string, DBEntityReference>
): InlineReferencePart {
  if (part.declaration.kind !== 'molecular-document' || part.state.status !== 'resolved')
    return part;
  const locator = molecularDocumentReferenceLocator(part.declaration.document);
  const { viewId: _viewId, groupId: _groupId, ...documentTarget } = part.declaration.document;
  const documentLocator = molecularDocumentReferenceLocator(documentTarget);
  const persisted = referenceIds
    .map((id) => references.get(id))
    .find((reference) => {
      if (reference?.entity_type !== 'molecular-document' || reference.status !== 'created')
        return false;
      const target = molecularDocumentReferenceFromData(reference.data);
      if (!target || molecularDocumentReferenceLocator(target) !== reference.locator) return false;
      return (
        reference.locator === locator ||
        (!target.viewId && !target.groupId && reference.locator === documentLocator)
      );
    });
  if (!persisted) return part;
  if (
    part.state.referenceId === persisted.id &&
    part.state.reference?.id === persisted.id &&
    part.state.reference.locator === locator &&
    part.state.reference.display_label === part.label
  )
    return part;
  return {
    ...part,
    state: {
      ...part.state,
      referenceId: persisted.id,
      reference: {
        ...persisted,
        display_label: part.label,
        locator,
        data: JSON.stringify(part.declaration.document),
      },
    },
  };
}

export function bindPersistedMolecularDocumentReferences(
  document: InlineTextDocument,
  referenceIds: readonly string[],
  references: ReadonlyMap<string, DBEntityReference>
): InlineTextDocument {
  const parts = document.parts.map((part) =>
    bindPersistedMolecularDocumentPart(part, referenceIds, references)
  );
  return parts.every((part, index) => part === document.parts[index])
    ? document
    : { ...document, parts };
}

export function projectPersistedInlineTextDocument(
  source: string,
  referenceIds: readonly string[],
  references: ReadonlyMap<string, DBEntityReference>
): InlineTextDocument {
  const document = buildInlineTextDocument(source, { streaming: false });
  const entityParts = document.parts.filter(
    (part) => part.declaration.kind === 'existing-reference'
  );
  const nodeIds = entityParts.map((part) =>
    part.declaration.kind === 'existing-reference' ? part.declaration.referenceId : ''
  );
  const structurallyAuthorized =
    nodeIds.length === referenceIds.length &&
    new Set(nodeIds).size === nodeIds.length &&
    nodeIds.every((id, index) => id === referenceIds[index] && references.has(id));
  const pathBackedEntityLocators = new Set(
    structurallyAuthorized
      ? referenceIds.flatMap((id) => {
          const locator = references.get(id)?.locator;
          return locator?.startsWith('git://') ? [locator] : [];
        })
      : []
  );

  return {
    ...document,
    parts: document.parts.map((part) => {
      if (part.declaration.kind === 'molecular-document') {
        return bindPersistedMolecularDocumentPart(
          {
            ...part,
            state: {
              status: 'resolved' as const,
              canonicalLabel: part.label,
              reference: molecularDocumentReferenceRecord(part.declaration.document, part.label),
            },
          },
          referenceIds,
          references
        );
      }
      if (part.declaration.kind === 'workspace-path') {
        const locator = `git://${part.declaration.root}/${part.declaration.segments.join('/')}`;
        const canonicalLabel = stripDisplayExtension(
          part.declaration.segments[part.declaration.segments.length - 1] ?? part.declaration.root
        );
        if (pathBackedEntityLocators.has(locator)) {
          return {
            ...part,
            state: { status: 'suppressed-duplicate' as const, canonicalLabel },
          };
        }
        return {
          ...part,
          state: {
            status: 'resolved' as const,
            canonicalLabel,
          },
        };
      }
      if (part.declaration.kind !== 'existing-reference') return part;
      const reference = structurallyAuthorized
        ? references.get(part.declaration.referenceId)
        : undefined;
      if (!reference) return part;
      return {
        ...part,
        state: {
          status: 'resolved' as const,
          canonicalLabel: stripDisplayExtension(reference.display_label),
          referenceId: reference.id,
          reference,
        },
      };
    }),
  };
}
