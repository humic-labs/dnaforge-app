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
    const visit = (node: JSONContent) => {
      if (node.type === 'codeBlock' || node.type === 'rawMarkdown') return;
      const input = inputFor(node);
      if (input) {
        const key = canonicalJson(input);
        found.set(key, (found.get(key) ?? 0) + 1);
      }
      node.content?.forEach(visit);
    };
    visit(normalizeNotebookReferences(content));
    return found;
  };
  return {
    resolve,
    async prepare(scope: NativeNotebookScope, content: JSONContent, previousContent: JSONContent) {
      if (canonicalJson(content) === canonicalJson(previousContent))
        return { content, verify: async () => scope.assertCurrent() };
      const previous = counts(previousContent);
      const verifiers: Array<() => Promise<void>> = [];
      const visit = async (node: JSONContent): Promise<JSONContent> => {
        if (node.type === 'codeBlock' || node.type === 'rawMarkdown') return node;
        const input = inputFor(node);
        if (input) {
          const key = canonicalJson(input),
            remaining = previous.get(key) ?? 0;
          previous.set(key, Math.max(0, remaining - 1));
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
        return node.content
          ? { ...node, content: await Promise.all(node.content.map(visit)) }
          : node;
      };
      const prepared = await visit(normalizeNotebookReferences(content));
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
