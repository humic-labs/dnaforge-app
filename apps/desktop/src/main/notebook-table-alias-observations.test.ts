// @vitest-environment node

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNotebookTableAliases } from './notebook-table-aliases';
import {
  richTableReference,
  type TableDocumentReference,
} from '../shared/table-document-reference';
import type { TableDocumentCommandResult } from '../shared/table-document-command';
import type { NativeNotebookScope } from './notebook-document-owner';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([false, true])(
  'verifies unchanged table placements when parallel reference reads finish in a different order (unavailable: %s)',
  async (unavailable) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'table-alias-order-')));
    roots.push(root);
    const projectId = 'fdce7427-d431-4a77-a686-5799c4aab3bd';
    const tableId = 'bde67e21-83bc-4f62-b5b0-33dc1be04327';
    const current = richTableReference(projectId, tableId);
    const digest = '1'.repeat(64);
    const pinned = richTableReference(projectId, tableId, {
      kind: 'saved-version',
      savedVersionId: digest,
      sha256: `sha256:${digest}`,
    });
    let calls = 0;
    let pending: {
      reference: TableDocumentReference;
      done: (result: TableDocumentCommandResult) => void;
      fail: (error: Error) => void;
    }[] = [];
    const aliases = createNotebookTableAliases({
      tableDocuments: () => ({
        execute: async (command) => {
          if (command.kind !== 'resolve')
            throw new Error('Expected a read-only reference resolution');
          const batch = Math.floor(calls++ / 2);
          return new Promise<TableDocumentCommandResult>((done, fail) => {
            pending.push({ reference: command.reference, done, fail });
            if (pending.length !== 2) return;
            const entries = pending;
            pending = [];
            void (async () => {
              for (const { reference, done, fail } of batch % 2
                ? [...entries].reverse()
                : entries) {
                if (unavailable) {
                  fail(new Error(`Unavailable retained ${reference.binding.kind} owner`));
                  await new Promise<void>((resolve) => setImmediate(resolve));
                  continue;
                }
                done({
                  kind: 'resolved',
                  table: {
                    reference,
                    tableId,
                    projectId,
                    readOnly: reference.binding.kind === 'saved-version',
                    owner:
                      reference.binding.kind === 'saved-version'
                        ? {
                            kind: 'saved-version',
                            snapshotSha256: digest,
                            snapshot: {
                              schema: 'dnaforge.table-snapshot.v1',
                              documentId: tableId,
                              title: 'Table',
                              data: {
                                rows: 1,
                                cols: 1,
                                cells: [[{ value: 'retained', type: 'text' }]],
                              },
                            },
                          }
                        : {
                            kind: 'file',
                            documentId: 'native-owner',
                            path: join(root, 'Table/.forge/table.json'),
                            workspaceRoot: root,
                          },
                  },
                });
                await new Promise<void>((resolve) => setImmediate(resolve));
              }
            })();
          });
        },
      }),
    });
    const scope = {
      documentId: 'ws1::notebook',
      workspaceRoot: root,
      path: join(root, 'Notebook'),
      readOnly: false,
      assertCurrent() {},
    } satisfies NativeNotebookScope;
    const content = {
      type: 'doc',
      content: [current, pinned].map((reference, index) => ({
        type: 'embed',
        attrs: {
          type: 'table-reference',
          version: 1,
          refId: `placement-${index}`,
          data: { reference, presentation: 'embed' },
        },
      })),
    };
    const prepared = await aliases.prepare(scope, content);
    expect(prepared.content).toEqual(content);
    await expect(prepared.verify()).resolves.toBeUndefined();
    expect(calls).toBe(4);
  }
);
