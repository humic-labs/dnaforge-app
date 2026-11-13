import { describe, expect, it } from 'vitest';
import {
  createRevisionGraph,
  defineBlob,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  exportCanonicalClosure,
  importCanonicalRecords,
} from '@waypoint/workspace-revisions/codec';
import { applyScientificBatch, createScientificReader } from './index';
import { compileScientificAssembly } from './assembly';
import type { ScientificFileEntry } from './workspace';

const must = <T, E>(value: Result<T, E>): T => {
  if (!value.ok) throw Error(JSON.stringify(value.error));
  return value.value;
};
const id = (value: string) => must(parseResourceId(value));
const path = (value: string) => must(parseWorkspacePath(value));
const refName = must(parseRefName('accepted'));
const primer = {
  formatVersion: 1,
  kind: 'primer',
  name: 'Shared',
  molecule: 'DNA',
  bases: 'ACGT',
  modifications: [],
  fields: {},
};
const sequence = {
  formatVersion: 1,
  kind: 'sequence',
  name: 'Donor',
  molecule: 'DNA',
  bases: 'ACGTACGT',
  topology: 'linear',
  annotations: [],
  fields: {},
};
const entries = [
  { resourceId: id('source'), path: path('source.json'), document: sequence },
  { resourceId: id('primer'), path: path('primer.json'), document: primer },
  {
    resourceId: id('product'),
    path: path('product.json'),
    document: { ...sequence, name: 'Product', bases: 'ACGTACGTACGT', topology: 'circular' },
  },
] satisfies ScientificFileEntry[];
const draft = {
  resourceId: id('assembly-1'),
  path: path('history/1.json'),
  constructId: id('construct'),
  parent: null,
  sources: [{ kind: 'submitted' as const, resourceId: id('source') }],
  primers: [{ kind: 'submitted' as const, resourceId: id('primer') }],
  product: { kind: 'submitted' as const, resourceId: id('product') },
  recipe: { method: 'gibson', actor: 'fixture', additional: { protocol: 'preserve in full' } },
};
function fixture() {
  let graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('science')),
    acceptedRef: refName,
  });
  let head: WorkspaceVersionId | null = null;
  const blobs = new Map<string, Uint8Array>();
  const readBlob = (blob: { hash: string }) => blobs.get(blob.hash) ?? null;
  const reader = () => createScientificReader({ graph, head, readBlob });
  const submit = (
    all: readonly ScientificFileEntry[],
    assembly: unknown = draft,
    operation = 'accept',
    base = head
  ) => {
    const plan = compileScientificAssembly({ graph, head: base, entries: all, assembly, readBlob });
    for (const bytes of plan.blobs) blobs.set(defineBlob(bytes).hash, bytes);
    const result = applyScientificBatch({
      graph,
      refName,
      expectedHead: base,
      operationId: must(parseOperationId(operation)),
      ...plan,
      readBlob,
    });
    graph = result.graph;
    if (result.kind === 'changed') head = result.version.id;
    return result;
  };
  return { submit, reader, graph: () => graph, head: () => head, blobs };
}
describe('atomic scientific assembly compilation', () => {
  it('accepts new product, primers, source and exact recipe pins in one version without publishing previews', () => {
    const f = fixture();
    expect(f.submit(entries).kind).toBe('changed');
    const history = f.reader().current(id('assembly-1'))!;
    expect(history.document).toMatchObject({
      kind: 'accepted-assembly',
      sources: [{ resourceId: 'source', revisionId: f.reader().current(id('source'))!.revisionId }],
      primers: [{ resourceId: 'primer', revisionId: f.reader().current(id('primer'))!.revisionId }],
      product: { resourceId: 'product', revisionId: f.reader().current(id('product'))!.revisionId },
      recipe: draft.recipe,
    });
    const closure = exportCanonicalClosure(f.graph());
    expect(closure.records.filter((row) => row.kind === 'workspace-version')).toHaveLength(1);
    expect(closure.records.filter((row) => row.kind === 'operation-receipt')).toHaveLength(1);
    expect(importCanonicalRecords(closure).ok).toBe(true);
  });
  it('never stores the product if the accepted-history parent belongs to another construct', () => {
    const f = fixture();
    f.submit(entries);
    const parent = f.reader().current(id('assembly-1'))!;
    const head = f.head();
    const all = [
      ...entries.map((entry) =>
        entry.resourceId === 'product'
          ? { ...entry, document: { ...sequence, name: 'Changed product', bases: 'TTTTACGT' } }
          : entry
      ),
      { resourceId: parent.resourceId, path: path('history/1.json'), document: parent.document },
    ];
    expect(
      f.submit(
        all,
        {
          ...draft,
          resourceId: id('assembly-2'),
          path: path('history/2.json'),
          constructId: id('different-construct'),
          parent: { resourceId: parent.resourceId, revisionId: parent.revisionId },
        },
        'bad-child'
      ).kind
    ).toBe('rejected');
    expect(f.head()).toBe(head);
    expect(f.reader().current(id('product'))?.document).toMatchObject({ bases: 'ACGTACGTACGT' });
    expect(f.reader().current(id('assembly-2'))).toBeNull();
  });
  it('creates a new history node when the same shared primer and product advance, preserving the original pins', () => {
    const f = fixture();
    f.submit(entries);
    const parent = f.reader().current(id('assembly-1'))!;
    const oldPrimer = f.reader().current(id('primer'))!,
      oldProduct = f.reader().current(id('product'))!;
    const all = [
      ...entries.map((entry) =>
        entry.resourceId === 'primer'
          ? { ...entry, document: { ...primer, bases: 'AAAA' } }
          : entry.resourceId === 'product'
            ? { ...entry, document: { ...sequence, bases: 'AAAAACGT' } }
            : entry
      ),
      { resourceId: parent.resourceId, path: path('history/1.json'), document: parent.document },
    ];
    expect(
      f.submit(
        all,
        {
          ...draft,
          resourceId: id('assembly-2'),
          path: path('history/2.json'),
          parent: { resourceId: parent.resourceId, revisionId: parent.revisionId },
        },
        'child'
      ).kind
    ).toBe('changed');
    expect(f.reader().revision(parent)).toEqual(parent);
    expect(f.reader().revision(oldPrimer)).toEqual(oldPrimer);
    expect(f.reader().revision(oldProduct)).toEqual(oldProduct);
    expect(f.reader().current(id('assembly-2'))?.document).toMatchObject({
      primers: [{ resourceId: 'primer', revisionId: f.reader().current(id('primer'))!.revisionId }],
    });
  });
  it('rebuilds an exact original request after newer history without persisting or accepting an intermediate preview', () => {
    const f = fixture();
    f.submit(entries, draft, 'original', null);
    const originalHead = f.head();
    expect(
      f.submit(
        entries,
        { ...draft, resourceId: id('assembly-2'), path: path('history/2.json') },
        'other',
        originalHead
      ).kind
    ).toBe('rejected');

    const parent = f.reader().current(id('assembly-1'))!;
    const all = [
      ...entries,
      { resourceId: parent.resourceId, path: path('history/1.json'), document: parent.document },
    ];
    expect(
      f.submit(
        all,
        {
          ...draft,
          resourceId: id('assembly-2'),
          path: path('history/2.json'),
          parent: { resourceId: parent.resourceId, revisionId: parent.revisionId },
        },
        'child'
      ).kind
    ).toBe('changed');
    const head = f.head();
    expect(f.submit(entries, draft, 'original', null).kind).toBe('replay');
    expect(f.head()).toBe(head);
    expect(
      exportCanonicalClosure(f.graph()).records.filter((row) => row.kind === 'workspace-version')
    ).toHaveLength(2);
  });
  it('refuses unresolved submitted inputs and wrong-kind pins before publication', () => {
    const f = fixture();
    expect(() =>
      f.submit(entries, { ...draft, product: { kind: 'submitted', resourceId: id('missing') } })
    ).toThrow(/product|submitted/i);
    expect(() =>
      f.submit(entries, { ...draft, sources: [{ kind: 'submitted', resourceId: id('primer') }] })
    ).toThrow(/sequence|source/i);
    expect(f.head()).toBeNull();
    expect(exportCanonicalClosure(f.graph()).records).toEqual([]);
  });
});
