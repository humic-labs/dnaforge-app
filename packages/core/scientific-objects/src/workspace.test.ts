import { describe, expect, it } from 'vitest';
import {
  createRevisionGraph,
  defineBlob,
  listWorkspaceResources,
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
import {
  compileScientificWorkspace,
  parseScientificIdentityMap,
  scientificIdentityPath,
} from './workspace';

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
const entry = (resourceId: string, file: string, document: unknown = primer) => ({
  resourceId: id(resourceId),
  path: path(file),
  document,
});
function fixture() {
  let graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('science')),
    acceptedRef: refName,
  });
  let head: WorkspaceVersionId | null = null;
  let serial = 0;
  const blobs = new Map<string, Uint8Array>();
  const submit = (
    entries: Parameters<typeof compileScientificWorkspace>[0]['entries'],
    operation = `submit-${++serial}`,
    base = head
  ) => {
    const plan = compileScientificWorkspace({ graph, head: base, entries });
    for (const bytes of plan.blobs) blobs.set(defineBlob(bytes).hash, bytes);
    const result = applyScientificBatch({
      graph,
      expectedHead: base,
      refName,
      operationId: must(parseOperationId(operation)),
      mutations: plan.mutations,
      readBlob: (blob) => blobs.get(blob.hash) ?? null,
    });
    graph = result.graph;
    if (result.kind === 'changed') head = result.version.id;
    return result;
  };
  return {
    submit,
    graph: () => graph,
    head: () => head,
    blobs,
    reader: () =>
      createScientificReader({ graph, head, readBlob: (blob) => blobs.get(blob.hash) ?? null }),
  };
}

describe('complete scientific working-file compilation', () => {
  it('accepts primers, sequences and strains with one reproducible identity map and reopens', () => {
    const f = fixture();
    const entries = [
      entry('p', 'primers/p.json'),
      entry('s', 's.json', sequence),
      entry('host', 'host.json', {
        formatVersion: 1,
        kind: 'strain',
        name: 'BY4741',
        taxon: 'Saccharomyces cerevisiae',
        fields: {},
      }),
    ];
    expect(f.submit(entries).kind).toBe('changed');
    expect(f.reader().listCurrent()).toHaveLength(3);
    expect(must(listWorkspaceResources(f.graph(), f.head()!))).toHaveLength(4);
    const manifest = [...f.blobs.values()]
      .map((bytes) => new TextDecoder().decode(bytes))
      .find((text) => text.includes('"workspaceId"'))!;
    expect(
      parseScientificIdentityMap(manifest, 'science').entries.map((row) => row.resourceId)
    ).toEqual(['host', 'p', 's']);
    expect(importCanonicalRecords(exportCanonicalClosure(f.graph())).ok).toBe(true);
    expect(f.submit([...entries].reverse()).kind).toBe('no-op');
  });
  it('preserves identity on a move, assigns a copy its own identity, and retains deleted history', () => {
    const f = fixture();
    f.submit([entry('p', 'p.json'), entry('s', 's.json', sequence)]);
    const original = f.reader().current(id('p'))!;
    expect(
      f.submit([
        entry('p', 'nested/p.json'),
        entry('copy', 'copy.json'),
        entry('s', 's.json', sequence),
      ]).kind
    ).toBe('changed');
    expect(f.reader().current(id('p'))).toEqual(original);
    expect(f.reader().current(id('copy'))?.revisionId).not.toBe(original.revisionId);
    expect(f.submit([entry('copy', 'copy.json'), entry('s', 's.json', sequence)]).kind).toBe(
      'changed'
    );
    expect(f.reader().current(id('p'))).toBeNull();
    expect(f.reader().revision(original)).toEqual(original);
  });
  it('orders a move chain before creating a new file at the freed source path', () => {
    const f = fixture();
    f.submit([entry('a', 'a.json'), entry('b', 'b.json')]);
    expect(
      f.submit([entry('a', 'b.json'), entry('b', 'c.json'), entry('new', 'a.json')]).kind
    ).toBe('changed');
    const paths = must(listWorkspaceResources(f.graph(), f.head()!))
      .filter((slot) => slot.path !== scientificIdentityPath)
      .map((slot) => [slot.resourceId, slot.path]);
    expect(paths).toEqual([
      ['a', 'b.json'],
      ['b', 'c.json'],
      ['new', 'a.json'],
    ]);
  });
  it('recompiles exact retries against their original base after a newer acceptance', () => {
    const f = fixture(),
      original = [entry('p', 'p.json')];
    f.submit(original, 'first', null);
    f.submit([entry('p', 'moved.json', { ...primer, bases: 'AAAA' })]);
    const head = f.head();
    expect(f.submit(original, 'first', null).kind).toBe('replay');
    expect(f.head()).toBe(head);
    expect(f.reader().current(id('p'))?.document).toMatchObject({ bases: 'AAAA' });
  });
  it('rejects duplicate, reserved, foreign and ambiguous identity maps without publishing', () => {
    const f = fixture();
    for (const entries of [
      [entry('p', 'p.json'), entry('p', 'q.json')],
      [entry('p', 'same.json'), entry('q', 'same.json')],
      [entry('p', scientificIdentityPath)],
      [entry('p', '.git/config')],
    ]) {
      expect(() => f.submit(entries)).toThrow();
      expect(f.head()).toBeNull();
    }
    const good = {
      formatVersion: 1,
      workspaceId: 'science',
      entries: [{ resourceId: 'p', path: 'p.json' }],
    };
    expect(() => parseScientificIdentityMap(JSON.stringify(good), 'other')).toThrow(/workspace/i);
    expect(() =>
      parseScientificIdentityMap(JSON.stringify({ ...good, extra: true }), 'science')
    ).toThrow();
    expect(() =>
      parseScientificIdentityMap(
        '{"formatVersion":1,"formatVersion":1,"workspaceId":"science","entries":[]}',
        'science'
      )
    ).toThrow();
  });
  it('rejects the complete submission when a removed primer still has a binding', () => {
    const f = fixture();
    f.submit([entry('p', 'p.json'), entry('s', 's.json', sequence)]);
    const target = f.reader().current(id('s'))!;
    const binding = entry('binding', 'binding.json', {
      formatVersion: 1,
      kind: 'primer-binding',
      primerId: id('p'),
      target: { resourceId: target.resourceId, revisionId: target.revisionId },
      coordinates: { start: 0, end: 4, strand: 1 },
    });
    f.submit([entry('p', 'p.json'), entry('s', 's.json', sequence), binding]);
    const head = f.head();
    expect(f.submit([entry('s', 's.json', sequence), binding]).kind).toBe('rejected');
    expect(f.head()).toBe(head);
    expect(f.reader().current(id('p'))).not.toBeNull();
  });
});
