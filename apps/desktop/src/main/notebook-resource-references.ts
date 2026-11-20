import { parseWorkTaskReferenceHref } from '../shared/work-task-reference';
import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { canonicalJson } from '../shared/canonical-json';
import { decodeInlineReferenceUrl } from '../shared/inline-reference-codec';
import { savedReferenceIdFromHref } from '../shared/saved-reference-url';
import { molecularDocumentReferenceFromHref } from '../shared/molecular-document-reference';
import { normalizeNotebookReferences } from '../shared/notebook-reference-normalization';
import {
  projectResourceReferenceSchema,
  type ProjectResourceReference,
} from '../shared/project-resource-reference';
import type { NativeNotebookScope } from './notebook-document-owner';
import {
  createRegisteredProjectAuthority,
  type RegisteredProjectAuthority,
} from './registered-project-authority';
import { createProjectResourceReferences } from './project-resource-references';
import { prepareNotebookReferenceInsertion } from './notebook-reference-insertion';
import {
  extractNotebookReferenceOccurrences,
  mapNotebookReferenceNodes,
  normalizeNotebookReferenceOccurrences,
} from '../shared/notebook-reference-occurrences';
import { resolveNotebookEntityTargets } from './resolve-notebook-entity-targets';

export function createNotebookResourceReferences(options: {
  db(): Database.Database;
  registeredProjects?: RegisteredProjectAuthority;
}) {
  const resources = createProjectResourceReferences(options);
  const projects = options.registeredProjects ?? createRegisteredProjectAuthority(options);
  const resolve = async (scope: NativeNotebookScope, input: string | ProjectResourceReference) => {
    scope.assertCurrent();
    const result = await resources.resolve(input);
    scope.assertCurrent();
    return result;
  };
  const inputFor = (node: JSONContent): string | ProjectResourceReference | null => {
    if (node.type !== 'mention') return null;
    if (node.attrs?.entityType === 'project-resource')
      return projectResourceReferenceSchema.parse(node.attrs.resourceReference);
    if (node.attrs?.entityType === 'native-catalog' && typeof node.attrs.entityId === 'string')
      return `entity://workspace/${encodeURIComponent(node.attrs.entityId)}`;
    const href = node.attrs?.referenceUri;
    if (typeof href !== 'string') return null;
    return /^(?:dnaforge-chat|entity):/iu.test(href) ? href : null;
  };
  const counts = (content: JSONContent): Map<string, number> => {
    const found = new Map<string, number>();
    mapNotebookReferenceNodes(normalizeNotebookReferences(content), (node) => {
      if (typeof node.attrs?.occurrenceId === 'string' && node.attrs.occurrenceId.trim())
        return node;
      const input = inputFor(node);
      if (input) {
        const key = canonicalJson(input);
        found.set(key, (found.get(key) ?? 0) + 1);
      }
      return node;
    });
    return found;
  };
  return {
    resolve,
    async prepare(
      scope: NativeNotebookScope,
      content: JSONContent,
      previousContent: JSONContent,
      retainedReferences: readonly JSONContent[] = []
    ) {
      if (canonicalJson(content) === canonicalJson(previousContent))
        return { content, verify: async () => scope.assertCurrent() };
      content = normalizeNotebookReferenceOccurrences(normalizeNotebookReferences(content), {
        documentId: scope.documentId,
      });
      const previousIds = new Set<string>();
      mapNotebookReferenceNodes(previousContent, (node) => {
        if (typeof node.attrs?.occurrenceId === 'string') previousIds.add(node.attrs.occurrenceId);
        return node;
      });
      const previousNormalized = normalizeNotebookReferenceOccurrences(previousContent, {
        documentId: scope.documentId,
      });
      const previousExplicit = extractNotebookReferenceOccurrences(previousNormalized);
      const previousById = new Map(
        previousExplicit.map((occurrence) => [occurrence.occurrenceId, occurrence])
      );
      const previousNodesById = new Map<string, JSONContent>();
      mapNotebookReferenceNodes(previousNormalized, (node) => {
        previousNodesById.set(node.attrs!.occurrenceId, node);
        return node;
      });
      const targetKey = (occurrence: (typeof previousExplicit)[number]) =>
        canonicalJson({
          targetEntityId: occurrence.targetEntityId,
          representationId: occurrence.representationId,
          versionId: occurrence.versionId,
          entityType: occurrence.entityType,
          targetReference: occurrence.targetReference,
        });
      const retainedByTarget = new Map<string, JSONContent>();
      for (const node of retainedReferences) {
        const occurrence = extractNotebookReferenceOccurrences(node)[0];
        if (occurrence)
          retainedByTarget.set(
            canonicalJson([occurrence.occurrenceId, targetKey(occurrence)]),
            node
          );
      }
      const retainedFor = (occurrence: (typeof previousExplicit)[number]) =>
        retainedByTarget.get(canonicalJson([occurrence.occurrenceId, targetKey(occurrence)]));
      const legacyTargets = new Map<string, number>();
      for (const occurrence of previousExplicit) {
        if (!previousIds.has(occurrence.occurrenceId))
          legacyTargets.set(
            targetKey(occurrence),
            (legacyTargets.get(targetKey(occurrence)) ?? 0) + 1
          );
      }
      const targets = new Set<string>();
      for (const occurrence of extractNotebookReferenceOccurrences(content)) {
        const previous = previousById.get(occurrence.occurrenceId);
        const key = targetKey(occurrence);
        if (previous && targetKey(previous) === key) {
          if (!previousIds.has(occurrence.occurrenceId))
            legacyTargets.set(key, Math.max(0, (legacyTargets.get(key) ?? 0) - 1));
          continue;
        }
        if (retainedFor(occurrence)) continue;
        const retainedLegacy = legacyTargets.get(key) ?? 0;
        if (retainedLegacy > 0) {
          legacyTargets.set(key, retainedLegacy - 1);
          continue;
        }
        if (occurrence.targetKind === 'unresolved')
          throw new Error('A new notebook reference requires an exact target identity.');
        if (occurrence.targetEntityId) targets.add(occurrence.targetEntityId);
      }
      const verifyEntityTargets = async () => {
        const ids = [...targets];
        for (let offset = 0; offset < ids.length; offset += 100) {
          const resolved = await resolveNotebookEntityTargets(
            options.db(),
            { ids: ids.slice(offset, offset + 100) },
            () => scope.assertCurrent()
          );
          if (resolved.items.some((item) => item.status !== 'available'))
            throw new Error('A new or changed notebook reference target is unavailable.');
        }
        scope.assertCurrent();
      };
      await verifyEntityTargets();
      const previous = counts(previousContent);
      const verifiers: Array<() => Promise<void>> = [verifyEntityTargets];
      const visit = async (node: JSONContent): Promise<JSONContent> => {
        if (node.type === 'codeBlock' || node.type === 'rawMarkdown') return node;
        const input = inputFor(node);
        if (input) {
          const key = canonicalJson(input);
          const occurrence = extractNotebookReferenceOccurrences(node)[0];
          const previousNodes = [
            previousNodesById.get(node.attrs!.occurrenceId),
            occurrence ? retainedFor(occurrence) : undefined,
          ];
          const retainedOccurrence = previousNodes.some((previousNode) => {
            const priorInput = previousNode ? inputFor(previousNode) : null;
            return priorInput !== null && canonicalJson(priorInput) === key;
          });
          const legacyRemaining = previous.get(key) ?? 0;
          const remaining = retainedOccurrence ? 1 : legacyRemaining;
          if (!retainedOccurrence || !previousIds.has(node.attrs!.occurrenceId))
            previous.set(key, Math.max(0, legacyRemaining - 1));
          const declaration = typeof input === 'string' ? decodeInlineReferenceUrl(input) : null;
          const migrateLegacy =
            declaration?.ok &&
            (declaration.declaration.kind === 'workspace-path' ||
              declaration.declaration.kind === 'path-entity');
          if (remaining > 0 && !migrateLegacy) return node;
          const workTask = typeof input === 'string' ? parseWorkTaskReferenceHref(input) : null;
          if (workTask) {
            const prepared = await prepareNotebookReferenceInsertion(options.db(), scope, {
              kind: 'insert-reference',
              index: 0,
              workTask,
            });
            verifiers.push(prepared.verify);
            return node;
          }
          const referenceId = typeof input === 'string' ? savedReferenceIdFromHref(input) : null;
          const documentReference =
            typeof input === 'string' ? molecularDocumentReferenceFromHref(input) : null;
          if (referenceId || documentReference) {
            const saved = referenceId
              ? (options
                  .db()
                  .prepare('SELECT status,workspace_root_path FROM entity_references WHERE id=?')
                  .get(referenceId) as
                  | { status: string; workspace_root_path: string | null }
                  | undefined)
              : undefined;
            if (referenceId && saved?.status !== 'created')
              throw new Error('The saved reference is unavailable.');
            const owner = documentReference
              ? projects.resolve(documentReference.projectId)
              : saved?.workspace_root_path
                ? projects.resolve(saved.workspace_root_path)
                : null;
            if ((documentReference || saved?.workspace_root_path) && !owner)
              throw new Error('The saved reference project is unavailable.');
            const assertTarget = owner ? projects.capture(owner.projectId, false) : () => {};
            const targetScope = {
              ...scope,
              workspaceRoot: owner?.path ?? scope.workspaceRoot,
              assertCurrent: () => {
                assertTarget();
                scope.assertCurrent();
              },
            };
            const prepared = await prepareNotebookReferenceInsertion(options.db(), targetScope, {
              kind: 'insert-reference',
              index: 0,
              ...(referenceId ? { referenceId } : { documentReference: documentReference! }),
            });
            verifiers.push(prepared.verify);
            return node;
          }
          let value: Awaited<ReturnType<typeof resolve>>;
          try {
            value = await resolve(scope, input);
          } catch (error) {
            if (remaining > 0) return node;
            throw error;
          }
          verifiers.push(async () => {
            const current = await resolve(scope, input);
            if (
              canonicalJson(current.reference) !== canonicalJson(value.reference) ||
              current.path !== value.path
            )
              throw new Error('The project resource changed while preparing this notebook edit.');
          });
          if (node.attrs?.entityType === 'native-catalog') return node;
          return {
            ...node,
            attrs: {
              ...node.attrs,
              entityType: 'project-resource',
              resourceReference: value.reference,
              projectId: value.reference.projectId,
              referenceUri: null,
              entityId: null,
              path: null,
            },
          };
        }
        return node;
      };
      const nodes: JSONContent[] = [];
      mapNotebookReferenceNodes(content, (node) => {
        nodes.push(node);
        return node;
      });
      const replacements = new Map<JSONContent, JSONContent>();
      for (const node of nodes) replacements.set(node, await visit(node));
      const prepared = mapNotebookReferenceNodes(content, (node) => replacements.get(node) ?? node);
      return {
        content: prepared,
        verify: async () => {
          for (const verify of verifiers) await verify();
          scope.assertCurrent();
        },
      };
    },
  };
}
