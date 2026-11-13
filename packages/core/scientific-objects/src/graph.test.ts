import { describe, expect, it } from 'vitest';
import {
  createRevisionGraph,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type WorkspaceMutation,
  type Result,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  exportCanonicalClosure,
  importCanonicalRecords,
} from '@waypoint/workspace-revisions/codec';
import { applyScientificBatch, createScientificReader, defineScientificDocument } from './index';

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw Error(JSON.stringify(result.error));
  return result.value;
};
const id = (value: string) => must(parseResourceId(value));
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
function fixture() {
  let graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('science')),
    acceptedRef: refName,
  });
  let head: WorkspaceVersionId | null = null;
  let serial = 0;
  const blobs = new Map<string, Uint8Array>();
  const readBlob = (blob: { hash: string }) => blobs.get(blob.hash) ?? null;
  const create = (resource: string, document: unknown): WorkspaceMutation => {
    const defined = defineScientificDocument(document);
    blobs.set(defined.blob.hash, new TextEncoder().encode(defined.text));
    return {
      kind: 'create-resource',
      resourceId: id(resource),
      path: must(parseWorkspacePath(`${resource}.json`)),
      state: defined.state,
      origin: { kind: 'created' },
    };
  };
  const submit = (mutations: readonly WorkspaceMutation[]) => {
    const result = applyScientificBatch({
      graph,
      refName,
      expectedHead: head,
      operationId: must(parseOperationId(`operation-${++serial}`)),
      mutations,
      readBlob,
    });
    graph = result.graph;
    if (result.kind === 'changed') head = result.version.id;
    return result;
  };
  const reader = () => createScientificReader({ graph, head, readBlob });
  const pin = (resource: string) => {
    const found = reader().current(id(resource));
    if (!found) throw Error(resource);
    return { resourceId: found.resourceId, revisionId: found.revisionId };
  };
  return { create, submit, reader, pin, readBlob, blobs, graph: () => graph, head: () => head };
}

describe('scientific acceptance over the revision engine', () => {
  it('rejects the entire product and assembly submission when one historical reference is wrong', () => {
    const f = fixture();
    expect(f.submit([f.create('primer', primer), f.create('source', sequence)]).kind).toBe(
      'changed'
    );
    const oldHead = f.head();
    const result = f.submit([
      f.create('product', sequence),
      f.create('assembly', {
        formatVersion: 1,
        kind: 'accepted-assembly',
        constructId: id('construct'),
        parent: null,
        sources: [f.pin('primer')],
        primers: [f.pin('primer')],
        product: f.pin('source'),
        recipe: {},
      }),
    ]);
    expect(result.kind).toBe('rejected');
    expect(f.head()).toBe(oldHead);
    expect(f.reader().current(id('product'))).toBeNull();
    expect(must(listWorkspaceResources(f.graph(), oldHead!))).toHaveLength(2);
    expect(importCanonicalRecords(exportCanonicalClosure(f.graph())).ok).toBe(true);
  });
  it('reads moved resources by identity and retains exact history after membership removal', () => {
    const f = fixture();
    f.submit([f.create('primer', primer)]);
    const exact = f.pin('primer'),
      before = f.reader().revision(exact);
    f.submit([
      {
        kind: 'move-resource',
        resourceId: id('primer'),
        expectedPath: must(parseWorkspacePath('primer.json')),
        destination: must(parseWorkspacePath('archive/primer.json')),
      },
    ]);
    expect(f.pin('primer')).toEqual(exact);
    f.submit([
      {
        kind: 'remove-membership',
        resourceId: id('primer'),
        expectedRevision: exact.revisionId,
        expectedPath: must(parseWorkspacePath('archive/primer.json')),
      },
    ]);
    expect(f.reader().current(id('primer'))).toBeNull();
    expect(f.reader().revision(exact)).toEqual(before);
    expect(f.reader().revision({ ...exact, resourceId: id('wrong-owner') })).toBeNull();
    expect(f.reader().hasRevision({ ...exact, resourceId: id('wrong-owner') })).toBe(false);
  });
  it('blocks accepted history edits through the same command path as ordinary edits', () => {
    const f = fixture();
    f.submit([f.create('primer', primer), f.create('source', sequence)]);
    const recipe = {
      formatVersion: 1,
      kind: 'accepted-assembly',
      constructId: id('construct'),
      parent: null,
      sources: [f.pin('source')],
      primers: [f.pin('primer')],
      product: f.pin('source'),
      recipe: { method: 'gibson' },
    };
    f.submit([f.create('assembly', recipe)]);
    const exact = f.pin('assembly');
    const changed = defineScientificDocument({ ...recipe, recipe: { method: 'golden_gate' } });
    f.blobs.set(changed.blob.hash, new TextEncoder().encode(changed.text));
    const result = f.submit([
      {
        kind: 'edit-resource',
        resourceId: id('assembly'),
        expectedRevision: exact.revisionId,
        state: changed.state,
      },
    ]);
    expect(result).toMatchObject({ kind: 'rejected', error: { kind: 'invalid-mutation' } });
    expect(f.pin('assembly')).toEqual(exact);
  });
  it('refuses missing or corrupted content rather than accepting a guessed scientific state', () => {
    const f = fixture(),
      command = f.create('source', sequence);
    const bytes = [...f.blobs.values()][0]!;
    bytes[0] = 0;
    expect(() => f.submit([command])).toThrow(/blob/i);
    expect(f.head()).toBeNull();
    expect(exportCanonicalClosure(f.graph()).records).toEqual([]);
    f.blobs.clear();
    expect(() => f.submit([command])).toThrow(/blob/i);
  });
});
