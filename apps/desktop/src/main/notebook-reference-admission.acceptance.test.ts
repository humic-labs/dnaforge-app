import type { JSONContent } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNotebookResourceReferences } from './notebook-resource-references';
import { normalizeNotebookReferenceOccurrences } from '../shared/notebook-reference-occurrences';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookSource,
  type NativeNotebookRecord,
} from './notebook-document-owner';
import { contentFingerprint } from '../shared/content-fingerprint';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

let fixture: ReturnType<typeof createFileTestDb>;
let references: ReturnType<typeof createNotebookResourceReferences>;
const scope = {
  documentId: 'repo::notebook',
  path: '/fixtures/alpha/Notebook',
  workspaceRoot: '/fixtures/alpha',
  readOnly: false,
  assertCurrent: () => {},
};
const occurrence = '10000000-0000-4000-8000-000000000001';
function mention(id: string, occurrenceId: string | undefined = occurrence): JSONContent {
  return {
    type: 'mention',
    attrs: {
      id,
      entityId: id,
      entityType: 'sequence',
      label: 'Target',
      ...(occurrenceId ? { occurrenceId } : {}),
    },
  };
}
function doc(...children: JSONContent[]): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: children }] };
}
function available(id: string) {
  fixture.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','Target',?,'file',1,1,1)"
    )
    .run(id, `entity://sequence/${id}`);
  fixture.db
    .prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES(?,?,1,?,'waypoint-sequence','current',1,1)"
    )
    .run(`file-${id}`, id, `/fixtures/alpha/${id}`);
}
beforeEach(() => {
  fixture = createFileTestDb('notebook-admission');
  ensureSchema(fixture.db, fixture.dbPath);
  fixture.db.exec(
    "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,'Alpha','/fixtures/alpha','repo',1)"
  );
  references = createNotebookResourceReferences({ db: () => fixture.db });
});
afterEach(() => fixture.cleanup());

describe('native notebook target admission', () => {
  it('requires a real exact target for a newly authored ordinary mention', async () => {
    await expect(references.prepare(scope, doc(mention('missing')), doc())).rejects.toThrow(
      /unavailable/i
    );
    available('existing');
    const prepared = await references.prepare(scope, doc(mention('existing')), doc());
    await expect(prepared.verify()).resolves.toBeUndefined();
  });

  it('preserves an unavailable authored occurrence during unrelated edits', async () => {
    const previous = doc(mention('missing'));
    const edited = doc({ type: 'text', text: 'Changed prose ' }, mention('missing'));
    const prepared = await references.prepare(scope, edited, previous);
    expect(prepared.content).toEqual(edited);
    await expect(prepared.verify()).resolves.toBeUndefined();
  });

  it('refuses retargeting and a copied occurrence to an unavailable target', async () => {
    const previous = doc(mention('original'));
    await expect(references.prepare(scope, doc(mention('new-missing')), previous)).rejects.toThrow(
      /unavailable/i
    );
    await expect(
      references.prepare(
        scope,
        doc(mention('original'), mention('original', '10000000-0000-4000-8000-000000000002')),
        previous
      )
    ).rejects.toThrow(/unavailable/i);
  });

  it('does not spend a legacy preservation allowance twice for the same unavailable target', async () => {
    const legacy: JSONContent = {
      type: 'mention',
      attrs: { id: 'missing', entityId: 'missing', entityType: 'sequence', label: 'Target' },
    };
    const previous = doc(legacy);
    const normalized = normalizeNotebookReferenceOccurrences(previous, {
      documentId: scope.documentId,
    });
    const existing = normalized.content![0].content![0];
    await expect(
      references.prepare(
        scope,
        doc(existing, mention('missing', '10000000-0000-4000-8000-000000000002')),
        previous
      )
    ).rejects.toThrow(/unavailable/i);
  });

  it('rechecks admission before publication after the target becomes unavailable', async () => {
    available('existing');
    const prepared = await references.prepare(scope, doc(mention('existing')), doc());
    fixture.db.prepare("UPDATE catalog_entities SET status='archived' WHERE id='existing'").run();
    await expect(prepared.verify()).rejects.toThrow(/unavailable/i);
  });

  it('does not infer a target from arbitrary embed attributes', async () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        { type: 'embed', attrs: { type: 'image', data: { content: [mention('missing')] } } },
      ],
    };
    const prepared = await references.prepare(scope, content, doc());
    expect(prepared.content).toEqual(content);
    await expect(prepared.verify()).resolves.toBeUndefined();
  });

  it('applies the same target admission to canonical native table cell links', async () => {
    const cell = (target: string): JSONContent => ({
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            refId: 'inline-table',
            data: {
              cells: [
                [
                  {
                    value: 'Target',
                    type: 'text',
                    reference: {
                      kind: 'native-entity',
                      entityId: target,
                      occurrenceId: occurrence,
                    },
                  },
                ],
              ],
            },
          },
        },
      ],
    });
    await expect(references.prepare(scope, cell('missing'), doc())).rejects.toThrow(/unavailable/i);
    const retained = await references.prepare(scope, cell('missing'), cell('missing'));
    await expect(retained.verify()).resolves.toBeUndefined();
    available('existing');
    const admitted = await references.prepare(scope, cell('existing'), doc());
    await expect(admitted.verify()).resolves.toBeUndefined();
  });

  it('retains native provenance across cut, save and paste of the same unavailable occurrence', async () => {
    let source: NativeNotebookSource = {
      content: doc(mention('missing')),
      title: 'Notebook',
      fingerprint: 'initial',
      metadataRaw: '{}',
      preservedPreamble: '',
      preservedTitleProjection: { kind: 'missing-heading', source: '' },
      sourceShape: 'v2-package',
    };
    let record: NativeNotebookRecord | undefined;
    const owner = new NativeNotebookWorkingCopyOwner({
      resolve: async () => scope,
      load: async () => structuredClone(source),
      prepareResourceReferences: references.prepare,
      publish: async (_scope, _prior, content, title) => {
        source = {
          ...source,
          content: structuredClone(content),
          title,
          fingerprint: contentFingerprint(JSON.stringify(content)),
        };
        return { source: structuredClone(source) };
      },
      loadRecord: async () => record,
      storeRecord: async (value) => {
        record = value;
      },
      retainedDirty: async () => [],
      normalizePath: (path) => path,
      prepareInsertion: async () => {
        throw new Error('unused');
      },
      search: async () => [],
      list: async () => [],
      create: async () => {
        throw new Error('unused');
      },
    });
    try {
      let state = await owner.execute({
        documentId: scope.documentId,
        operation: { kind: 'inspect-copy' },
      });
      const original = structuredClone(state.copy.content.content![0]);
      state = await owner.execute({
        documentId: scope.documentId,
        expectedRevision: state.revision,
        operation: {
          kind: 'splice-blocks',
          index: 0,
          deleteCount: 1,
          blocks: [{ type: 'paragraph' }],
        },
      });
      state = await owner.execute({
        documentId: scope.documentId,
        expectedRevision: state.revision,
        operation: { kind: 'save' },
      });
      expect(source.content.content![0].content ?? []).toEqual([]);
      state = await owner.execute({
        documentId: scope.documentId,
        expectedRevision: state.revision,
        operation: { kind: 'splice-blocks', index: 0, deleteCount: 1, blocks: [original] },
      });
      state = await owner.execute({
        documentId: scope.documentId,
        expectedRevision: state.revision,
        operation: { kind: 'save' },
      });
      expect(source.content.content![0].content![0].attrs).toMatchObject({
        entityId: 'missing',
        occurrenceId: occurrence,
      });
      const copied = structuredClone(original);
      copied.content![0].attrs!.occurrenceId = '10000000-0000-4000-8000-000000000002';
      await expect(
        owner.execute({
          documentId: scope.documentId,
          expectedRevision: state.revision,
          operation: { kind: 'splice-blocks', index: 1, deleteCount: 0, blocks: [copied] },
        })
      ).rejects.toThrow(/unavailable/i);
      const forged = doc(mention('forged-target', '10000000-0000-4000-8000-000000000099'));
      state = await owner.execute({
        documentId: scope.documentId,
        expectedRevision: state.revision,
        operation: {
          kind: 'retain-legacy-recovery',
          baseline: canonicalNotebookJson(source.content),
          content: forged,
        },
      });
      await expect(
        owner.execute({
          documentId: scope.documentId,
          expectedRevision: state.revision,
          operation: { kind: 'restore-recovery' },
        })
      ).rejects.toThrow(/unavailable/i);
      state = await owner.execute({
        documentId: scope.documentId,
        expectedRevision: state.revision,
        operation: { kind: 'discard' },
      });
      await expect(
        owner.execute({
          documentId: scope.documentId,
          expectedRevision: state.revision,
          operation: { kind: 'splice-blocks', index: 1, deleteCount: 0, blocks: forged.content! },
        })
      ).rejects.toThrow(/unavailable/i);
      expect(source.content.content![0].content![0].attrs?.entityId).toBe('missing');
    } finally {
      await owner.close();
    }
  });
});
