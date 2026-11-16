import type { JSONContent } from '@tiptap/core';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { canonicalJson } from '../shared/canonical-json';
import { detectDocumentPackage } from '../shared/document-package';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import {
  richTableReference,
  tableDocumentKey,
  tableDocumentReferenceSchema,
  type TableDocumentReference,
} from '../shared/table-document-reference';
import type { TableLegacyAlias } from '../shared/table-package';
import type { NativeNotebookScope } from './notebook-document-owner';
import type { NativeTableDocumentCommands } from './table-document-commands';
import { readTablePackageInMain, type ReadTablePackageResult } from './table-package';

interface NotebookTableAliasesOptions {
  tableDocuments?: () => Pick<NativeTableDocumentCommands, 'execute'>;
}

interface AliasClaim {
  table: ReadTablePackageResult;
  alias: TableLegacyAlias;
}

interface PreparedAliases {
  content: JSONContent;
  conflict?: string;
  verify(): Promise<void>;
}

const protectedNames = new Set(['.git', '.forge', '.dnaforge', '.waypoint', 'node_modules']);

function refuse(message: string): never {
  throw new Error(`TABLE_ALIAS_UNAVAILABLE: ${message}`);
}

async function existing(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertDirectory(root: string, path: string): Promise<void> {
  const member = relative(root, path);
  if (isAbsolute(member) || member === '..' || member.startsWith(`..${sep}`))
    refuse('A table alias package escaped its registered project.');
  let current = root;
  for (const part of ['', ...member.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      refuse('Table alias packages must use physical project directories.');
  }
}

async function packages(scope: NativeNotebookScope): Promise<ReadTablePackageResult[]> {
  const result: ReadTablePackageResult[] = [];
  const pending = [scope.workspaceRoot];
  let count = 0;
  const io = {
    exists: async (path: string) => Boolean(await existing(path)),
    readDir: async (path: string) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      })),
  };
  while (pending.length) {
    if (++count > 20000) refuse('This project exceeds the safe table alias scan size.');
    const directory = pending.pop()!;
    scope.assertCurrent();
    await assertDirectory(scope.workspaceRoot, directory);
    const marker = join(directory, '.forge');
    if (await existing(marker)) {
      await assertDirectory(scope.workspaceRoot, marker);
      if (await existing(join(marker, 'table.json'))) {
        result.push(
          await readTablePackageInMain({
            workspaceRoot: scope.workspaceRoot,
            packageRoot: directory,
          })
        );
        continue;
      }
      if (await detectDocumentPackage(directory, io)) continue;
    }
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith('.') &&
        !protectedNames.has(entry.name.toLowerCase())
      )
        pending.push(join(directory, entry.name));
  }
  scope.assertCurrent();
  return result;
}

function archivedBlock(claim: AliasClaim): JSONContent {
  const original = claim.alias.originalBlock;
  if (!original || typeof original !== 'object' || Array.isArray(original))
    refuse('The retired table alias does not retain its original selected block.');
  const block = original as JSONContent;
  const digest = createHash('sha256')
    .update(`${canonicalJson(block)}\n`)
    .digest('hex');
  if (
    claim.alias.originalBlockSha256 !== digest ||
    block.type !== 'embed' ||
    block.attrs?.type !== 'table' ||
    block.attrs?.refId !== claim.alias.blockId ||
    (block.attrs?.version ?? 1) !== 1
  )
    refuse('The retired table alias original payload or digest is inconsistent.');
  return block;
}

function tableNodes(content: JSONContent): boolean {
  if (
    content.type === 'embed' &&
    (content.attrs?.type === 'table' || content.attrs?.type === 'table-reference')
  )
    return true;
  return Boolean(content.content?.some(tableNodes));
}

export function createNotebookTableAliases(options: NotebookTableAliasesOptions) {
  const prepare = async (
    scope: NativeNotebookScope,
    content: JSONContent
  ): Promise<PreparedAliases> => {
    if (!tableNodes(content)) return { content, verify: async () => scope.assertCurrent() };
    const inspect = async () => {
      const tables = await packages(scope);
      const notebookId = stripWorkspaceScope(scope.documentId);
      const claims = new Map<string, AliasClaim[]>();
      for (const table of tables) {
        if (table.head.status !== 'active') continue;
        for (const alias of table.head.aliases) {
          if (alias.kind !== 'notebook-inline' || alias.notebookId !== notebookId) continue;
          const matches = claims.get(alias.blockId) ?? [];
          matches.push({ table, alias });
          claims.set(alias.blockId, matches);
        }
      }
      const observations: unknown[] = [];
      const conflicts: string[] = [];
      const resolve = async (reference: TableDocumentReference, sameProject: boolean) => {
        const service = options.tableDocuments?.();
        if (!service) refuse('The native table reference owner is unavailable.');
        const result = await service.execute({
          kind: 'resolve',
          reference,
          ...(sameProject ? { context: { workspaceRoot: scope.workspaceRoot } } : {}),
        });
        scope.assertCurrent();
        if (
          result.kind !== 'resolved' ||
          tableDocumentKey(result.table.reference) !== tableDocumentKey(reference)
        )
          refuse('The table reference did not resolve to its exact durable owner.');
        return result.table;
      };
      const visit = async (node: JSONContent): Promise<JSONContent> => {
        if (
          node.type !== 'embed' ||
          (node.attrs?.type !== 'table' && node.attrs?.type !== 'table-reference')
        )
          return node.content
            ? { ...node, content: await Promise.all(node.content.map(visit)) }
            : node;
        const blockId = node.attrs?.refId;
        if (typeof blockId !== 'string' || !blockId.length)
          refuse('The table placement has no stable block identity.');
        const matches = claims.get(blockId) ?? [];
        if (matches.length > 1)
          refuse('Multiple active table packages claim the same retired notebook table alias.');
        const claim = matches[0];
        const aliasReference = claim
          ? richTableReference(claim.alias.projectId, claim.table.head.id)
          : undefined;
        if (claim && aliasReference) {
          const target = await resolve(aliasReference, true);
          if (
            target.owner.kind !== 'file' ||
            target.owner.path !== claim.table.headPath ||
            target.tableId !== claim.table.head.id
          )
            refuse('The retired table alias does not match its verified project file owner.');
          archivedBlock(claim);
          observations.push({
            blockId,
            tableId: claim.table.head.id,
            projectId: claim.alias.projectId,
            headPath: claim.table.headPath,
            alias: claim.alias,
          });
        }
        if (node.attrs.type === 'table') {
          if (!claim || !aliasReference) return node;
          if (canonicalJson(node) !== canonicalJson(archivedBlock(claim))) {
            conflicts.push(
              'A restored inline table differs from its extracted table. The original restored data is preserved; resolve this notebook conflict before editing.'
            );
            return node;
          }
          return {
            ...node,
            attrs: {
              ...node.attrs,
              type: 'table-reference',
              version: 1,
              data: { reference: aliasReference, presentation: 'embed' },
            },
          };
        }
        if (node.attrs.version !== 1) {
          conflicts.push(
            'This table reference uses an unsupported saved version. Its original data is preserved.'
          );
          return node;
        }
        const reference = tableDocumentReferenceSchema.parse(node.attrs.data?.reference);
        tableDocumentKey(reference);
        if (reference.backing.kind !== 'rich-file')
          refuse('A notebook table reference must identify a durable table file.');
        if (node.attrs.data?.presentation !== 'embed' && node.attrs.data?.presentation !== 'link')
          refuse('The table reference has an unsupported presentation.');
        if (
          claim &&
          aliasReference &&
          (reference.backing.projectId !== claim.alias.projectId ||
            reference.documentId !== aliasReference.documentId)
        ) {
          conflicts.push(
            'The retired table placement points to a different table. Its original reference is preserved.'
          );
          return node;
        }
        try {
          await resolve(reference, false);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          conflicts.push(
            `The referenced table is unavailable or awaiting recovery. Its saved reference is preserved. ${reason}`
          );
          observations.push({ blockId, reference: tableDocumentKey(reference), reason });
          return node;
        }
        observations.push({ blockId, reference: tableDocumentKey(reference) });
        return node;
      };
      const prepared = await visit(content);
      scope.assertCurrent();
      return {
        content: prepared,
        ...(conflicts.length ? { conflict: [...new Set(conflicts)].join(' ') } : {}),
        observations,
      };
    };
    const prepared = await inspect();
    return {
      content: prepared.content,
      ...(prepared.conflict ? { conflict: prepared.conflict } : {}),
      verify: async () => {
        const current = await inspect();
        if (
          canonicalJson(current.content) !== canonicalJson(prepared.content) ||
          current.conflict !== prepared.conflict ||
          canonicalJson(current.observations) !== canonicalJson(prepared.observations)
        )
          refuse('The table alias owner changed while this notebook edit was prepared.');
        scope.assertCurrent();
      },
    };
  };
  return { prepare };
}
