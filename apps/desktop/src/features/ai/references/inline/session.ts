import {
  getEntityReferencesByIds,
  prepareEntityReferenceRow,
  type DBEntityReference,
} from '../../../../db/entity-references';
import { platform } from '../../../../platform';
import { stripDisplayExtension } from '../../../../utils/fileTypes';
import type {
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../../../../shared/inline-reference-ipc';
import type { WorkspaceFolder } from '../../../../stores/workspaceStore';
import { encodeInlineReferenceDeclaration, INLINE_REFERENCE_SCHEME } from './codec';
import { buildInlineTextDocument } from './document';
import type {
  InlineReferenceDeclaration,
  InlineReferencePart,
  InlineReferenceState,
  InlineTextDocument,
} from './types';
import { resolveMolecularDocumentReference } from '../../../molecular-documents/public/references';
import { molecularDocumentReferenceRecord } from '../../../../shared/molecular-document-reference';
import { resolveWorkspaceScope } from '../../../../db/workspace-catalog';

const DEFAULT_SETTLEMENT_DEADLINE_MS = 750;
const DEFAULT_MAX_CONCURRENT_RESOLUTIONS = 4;

interface ResolvedValue {
  state: InlineReferenceState;
  proposedRow?: DBEntityReference;
  targetIdentity?: string;
}

export interface FinalizedInlineTextBlock {
  id: string;
  content: string;
  document: InlineTextDocument;
  referenceIds: string[];
}

export interface FinalizedInlineReferenceSession {
  blocks: Map<string, FinalizedInlineTextBlock>;
  proposedRows: DBEntityReference[];

  referencedRows: DBEntityReference[];
}

export interface InlineReferenceSessionOptions {
  roots: readonly Pick<WorkspaceFolder, 'name' | 'path'>[];
  workspaceScope: string | null;
  allowedExistingReferenceIds: readonly string[];
  settlementDeadlineMs?: number;
  maxConcurrentResolutions?: number;
  onDocument?: (blockId: string, document: InlineTextDocument) => void;
  isScopeCurrent?: () => boolean;
  resolveTarget?: (
    request: ResolveInlineReferenceTargetRequest
  ) => Promise<ResolveInlineReferenceTargetResult>;
  loadReferences?: (ids: string[]) => Promise<DBEntityReference[]>;
  now?: () => number;
  createId?: () => string;
  buildDocument?: typeof buildInlineTextDocument;
}

export interface InlineReferenceSession {
  update(blockId: string, source: string): InlineTextDocument;

  registerCreatedReference(reference: DBEntityReference): void;
  finalize(): Promise<FinalizedInlineReferenceSession>;
  cancel(): void;
}

function declarationKey(declaration: InlineReferenceDeclaration): string {
  return encodeInlineReferenceDeclaration(declaration);
}

function escapeReadableLabel(label: string): string {
  return label.replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
}

function hasUnprojectedPrivateScheme(
  source: string,
  parts: readonly InlineReferencePart[]
): boolean {
  const scheme = `${INLINE_REFERENCE_SCHEME}://`;
  let offset = source.indexOf(scheme);
  while (offset >= 0) {
    const isCovered = parts.some(
      (part) => offset >= part.sourceRange.start && offset < part.sourceRange.end
    );
    if (!isCovered) return true;
    offset = source.indexOf(scheme, offset + scheme.length);
  }
  return false;
}

function applyStates(
  document: InlineTextDocument,
  states: ReadonlyMap<string, ResolvedValue>
): InlineTextDocument {
  return {
    ...document,
    parts: document.parts.map((part) => ({
      ...part,
      state: states.get(declarationKey(part.declaration))?.state ?? part.state,
    })),
  };
}

function canonicalReplacement(part: InlineReferencePart): string {
  if (part.state.status !== 'resolved') return escapeReadableLabel(part.label);

  const label = escapeReadableLabel(part.label);
  if (part.declaration.kind === 'molecular-document')
    return `[${label}](${encodeInlineReferenceDeclaration(part.declaration)})`;
  if (part.state.referenceId) {
    return `[${label}](${encodeInlineReferenceDeclaration({
      kind: 'existing-reference',
      referenceId: part.state.referenceId,
    })})`;
  }
  if (part.declaration.kind === 'workspace-path') {
    return `[${label}](${encodeInlineReferenceDeclaration(part.declaration)})`;
  }
  return label;
}

function canonicalizeDocument(
  blockId: string,
  current: InlineTextDocument,
  states: ReadonlyMap<string, ResolvedValue>
): {
  block: FinalizedInlineTextBlock;
  proposedRows: DBEntityReference[];
  referencedRows: DBEntityReference[];
} {
  const settled = applyStates(current, states);
  const seenReferences = new Set<string>();
  const referenceIds: string[] = [];
  const proposedRows: DBEntityReference[] = [];
  const replacements = settled.parts.map((part) => {
    const referenceId = part.state.status === 'resolved' ? part.state.referenceId : undefined;
    const isDuplicateReference = Boolean(referenceId && seenReferences.has(referenceId));
    if (referenceId && !isDuplicateReference) {
      seenReferences.add(referenceId);
      referenceIds.push(referenceId);
      const proposed = states.get(declarationKey(part.declaration))?.proposedRow;
      if (proposed) proposedRows.push(proposed);
    }
    return {
      range: part.sourceRange,
      value:
        isDuplicateReference && part.state.status === 'resolved'
          ? escapeReadableLabel(part.state.canonicalLabel)
          : canonicalReplacement(part),
    };
  });

  let content = settled.source;
  for (const replacement of replacements.sort((a, b) => b.range.start - a.range.start)) {
    content = `${content.slice(0, replacement.range.start)}${replacement.value}${content.slice(
      replacement.range.end
    )}`;
  }

  const canonical = buildInlineTextDocument(content, { streaming: false });
  const canonicalReferenceIds = canonical.parts.flatMap((part) =>
    part.declaration.kind === 'existing-reference' ? [part.declaration.referenceId] : []
  );
  if (
    canonicalReferenceIds.length !== referenceIds.length ||
    canonicalReferenceIds.some((id, index) => id !== referenceIds[index])
  ) {
    throw new Error('Inline reference canonicalization lost durable UUID authority.');
  }
  const referencesById = new Map<string, DBEntityReference>();
  for (const part of settled.parts) {
    if (part.state.status === 'resolved' && part.state.referenceId && part.state.reference) {
      referencesById.set(part.state.referenceId, part.state.reference);
    }
  }
  const document: InlineTextDocument = {
    ...canonical,
    parts: canonical.parts.map((part) => {
      if (part.declaration.kind === 'molecular-document') {
        const state = states.get(declarationKey(part.declaration))?.state;
        return state ? { ...part, state } : part;
      }
      if (part.declaration.kind === 'existing-reference') {
        const reference = referencesById.get(part.declaration.referenceId);
        if (reference) {
          return {
            ...part,
            state: {
              status: 'resolved' as const,
              canonicalLabel: stripDisplayExtension(reference.display_label),
              referenceId: reference.id,
              reference,
            },
          };
        }
      }
      if (part.declaration.kind === 'workspace-path') {
        const lastSegment = part.declaration.segments[part.declaration.segments.length - 1];
        const settledState = states.get(declarationKey(part.declaration))?.state;
        return {
          ...part,
          state: {
            status: 'resolved' as const,
            canonicalLabel: stripDisplayExtension(fileName(lastSegment ?? part.label)),
            targetType: settledState?.status === 'resolved' ? settledState.targetType : undefined,
          },
        };
      }
      return part;
    }),
  };

  return {
    block: { id: blockId, content, document, referenceIds },
    proposedRows,
    referencedRows: [...referencesById.values()],
  };
}

export function createInlineReferenceSession(
  options: InlineReferenceSessionOptions
): InlineReferenceSession {
  const roots = options.roots.map((root) => ({ name: root.name, path: root.path }));
  const allowedExistingIds = new Set(options.allowedExistingReferenceIds);
  const createdReferences = new Map<string, DBEntityReference>();
  const resolvedReference = (reference: DBEntityReference): ResolvedValue => ({
    state: {
      status: 'resolved',
      canonicalLabel: stripDisplayExtension(reference.display_label),
      referenceId: reference.id,
      reference,
    },
  });
  const documents = new Map<string, InlineTextDocument>();
  const states = new Map<string, ResolvedValue>();
  const declarations = new Map<string, InlineReferenceDeclaration>();
  const pending = new Map<string, Promise<void>>();
  const queue: Array<() => void> = [];
  const maxConcurrent = options.maxConcurrentResolutions ?? DEFAULT_MAX_CONCURRENT_RESOLUTIONS;
  const deadlineMs = options.settlementDeadlineMs ?? DEFAULT_SETTLEMENT_DEADLINE_MS;
  const resolveTarget =
    options.resolveTarget ?? ((request) => platform().fs.resolveInlineReferenceTarget(request));
  const loadReferences = options.loadReferences ?? getEntityReferencesByIds;
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const buildDocument = options.buildDocument ?? buildInlineTextDocument;
  let active = 0;
  let cancelled = false;
  let sealed = false;

  const publish = (key: string): void => {
    for (const [blockId, document] of documents) {
      if (!document.parts.some((part) => declarationKey(part.declaration) === key)) continue;
      const next = applyStates(document, states);
      documents.set(blockId, next);
      options.onDocument?.(blockId, next);
    }
  };

  const runLimited = <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolvePromise, rejectPromise) => {
      const start = (): void => {
        active += 1;
        void task()
          .then(resolvePromise, rejectPromise)
          .finally(() => {
            active -= 1;
            queue.shift()?.();
          });
      };
      if (active < maxConcurrent) start();
      else queue.push(start);
    });

  const resolveDeclaration = async (
    declaration: InlineReferenceDeclaration
  ): Promise<ResolvedValue> => {
    if (declaration.kind === 'molecular-document') {
      const scopes = await Promise.all(roots.map((root) => resolveWorkspaceScope(root.path)));
      if (!scopes.includes(declaration.document.projectId))
        return { state: { status: 'invalid', code: 'outside-workspace' } };
      const resolved = await resolveMolecularDocumentReference(declaration.document);
      const reference = molecularDocumentReferenceRecord(
        declaration.document,
        resolved.snapshot.title,
        undefined,
        resolved.saved.workspaceRoot
      );
      return { state: { status: 'resolved', canonicalLabel: resolved.snapshot.title, reference } };
    }
    if (declaration.kind === 'existing-reference') {
      if (!allowedExistingIds.has(declaration.referenceId)) {
        return { state: { status: 'invalid', code: 'unauthorized-reference' } };
      }
      const created = createdReferences.get(declaration.referenceId);
      if (created) return resolvedReference(created);
      const references = await loadReferences([declaration.referenceId]);
      const reference = references.find((candidate) => candidate.id === declaration.referenceId);
      return reference
        ? {
            state: {
              status: 'resolved',
              canonicalLabel: stripDisplayExtension(reference.display_label),
              referenceId: reference.id,
              reference,
            },
          }
        : { state: { status: 'invalid', code: 'reference-not-found' } };
    }

    const target = await resolveTarget({
      roots,
      root: declaration.root,
      segments: [...declaration.segments],
      targetKind: declaration.kind === 'workspace-path' ? 'workspace' : declaration.entityType,
    });
    if (!target.ok) return { state: { status: 'invalid', code: target.code } };
    if (options.isScopeCurrent && !options.isScopeCurrent()) {
      return { state: { status: 'invalid', code: 'workspace-changed' } };
    }

    const canonicalLabel = stripDisplayExtension(fileName(target.path));
    if (declaration.kind === 'workspace-path') {
      const reference = prepareEntityReferenceRow(
        {
          entityType:
            target.targetType === 'directory'
              ? 'folder'
              : target.targetType === 'sequence-package'
                ? 'sequence'
                : 'file',
          displayLabel: canonicalLabel,
          locator: `git://${declaration.root}/${target.relativePath}`,
          deepLinkParams: null,
          data: null,
          source: 'ai',
          workspaceScope: options.workspaceScope,
          workspaceRootPath: target.rootPath,
        },
        { id: createId(), now: now() }
      );
      return {
        state: {
          status: 'resolved',
          canonicalLabel,
          targetType: target.targetType,
          referenceId: reference.id,
          reference,
        },
        proposedRow: reference,
        targetIdentity: target.canonicalPath,
      };
    }

    const reference = prepareEntityReferenceRow(
      {
        entityType: declaration.entityType,
        displayLabel: canonicalLabel,
        locator: `git://${declaration.root}/${target.relativePath}`,
        deepLinkParams: null,
        data: null,
        source: 'ai',
        workspaceScope: options.workspaceScope,
        workspaceRootPath: target.rootPath,
      },
      { id: createId(), now: now() }
    );
    return {
      state: {
        status: 'resolved',
        canonicalLabel,
        referenceId: reference.id,
        reference,
      },
      proposedRow: reference,
      targetIdentity: target.canonicalPath,
    };
  };

  const ensureResolution = (declaration: InlineReferenceDeclaration): void => {
    const key = declarationKey(declaration);
    declarations.set(key, declaration);
    if (states.has(key) || pending.has(key) || cancelled || sealed) return;
    const resolution = runLimited(() => resolveDeclaration(declaration))
      .then((value) => {
        if (cancelled || sealed) return;
        const created =
          declaration.kind === 'existing-reference'
            ? createdReferences.get(declaration.referenceId)
            : undefined;
        if (created) value = resolvedReference(created);
        states.set(key, value);
        publish(key);
      })
      .catch(() => {
        if (cancelled || sealed) return;
        states.set(key, { state: { status: 'invalid', code: 'resolution-failed' } });
        publish(key);
      })
      .finally(() => pending.delete(key));
    pending.set(key, resolution);
  };

  return {
    registerCreatedReference(reference) {
      if (cancelled || sealed || reference.status !== 'created') return;
      const declaration: InlineReferenceDeclaration = {
        kind: 'existing-reference',
        referenceId: reference.id,
      };
      const key = declarationKey(declaration);
      allowedExistingIds.add(reference.id);
      createdReferences.set(reference.id, reference);
      states.set(key, resolvedReference(reference));
      publish(key);
    },
    update(blockId, source) {
      const previous = documents.get(blockId);
      const suffix =
        previous && source.startsWith(previous.source)
          ? source.slice(previous.source.length)
          : null;

      const parsed =
        previous &&
        suffix !== null &&
        previous.renderSource === previous.source &&
        !hasUnprojectedPrivateScheme(source, previous.parts)
          ? { ...previous, source, renderSource: source }
          : buildDocument(source, { streaming: true });
      for (const part of parsed.parts) ensureResolution(part.declaration);
      const next = applyStates(parsed, states);
      documents.set(blockId, next);
      return next;
    },
    async finalize() {
      if (!cancelled && pending.size > 0) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...pending.values()]),
          new Promise<void>((resolvePromise) => {
            deadline = setTimeout(resolvePromise, deadlineMs);
          }),
        ]);
        if (deadline) clearTimeout(deadline);
      }
      if (options.isScopeCurrent && !options.isScopeCurrent()) {
        for (const [key, declaration] of declarations) {
          if (declaration.kind !== 'existing-reference') {
            states.set(key, { state: { status: 'invalid', code: 'workspace-changed' } });
          }
        }
      }
      const entityTargetIdentities = new Set(
        [...declarations].flatMap(([key, declaration]) => {
          const resolved = states.get(key);
          return declaration.kind === 'path-entity' && resolved?.targetIdentity
            ? [resolved.targetIdentity]
            : [];
        })
      );
      for (const [key, declaration] of declarations) {
        if (declaration.kind !== 'workspace-path') continue;
        const resolved = states.get(key);
        if (!resolved?.targetIdentity || !entityTargetIdentities.has(resolved.targetIdentity)) {
          continue;
        }
        const canonicalLabel =
          resolved.state.status === 'resolved'
            ? resolved.state.canonicalLabel
            : stripDisplayExtension(
                fileName(declaration.segments[declaration.segments.length - 1] ?? declaration.root)
              );
        states.set(key, {
          ...resolved,
          state: { status: 'suppressed-duplicate', canonicalLabel },
        });
      }
      sealed = true;
      const blocks = new Map<string, FinalizedInlineTextBlock>();
      const proposedRows = new Map<string, DBEntityReference>();
      const referencedRows = new Map<string, DBEntityReference>();
      for (const [blockId, document] of documents) {
        const finalized = canonicalizeDocument(blockId, document, states);
        blocks.set(blockId, finalized.block);
        for (const row of finalized.proposedRows) proposedRows.set(row.id, row);
        for (const row of finalized.referencedRows) referencedRows.set(row.id, row);
      }
      return {
        blocks,
        proposedRows: [...proposedRows.values()],
        referencedRows: [...referencedRows.values()],
      };
    },
    cancel() {
      cancelled = true;
      states.clear();
      queue.length = 0;
    },
  };
}
