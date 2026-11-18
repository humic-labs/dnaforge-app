import { expect, it } from 'vitest';
import {
  createRevisionGraph,
  defineBlob,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
} from '@waypoint/workspace-revisions';
import {
  exportCanonicalClosure,
  importCanonicalRecords,
} from '@waypoint/workspace-revisions/codec';
import { applyScientificBatch, createScientificReader } from './graph';
import { compileScientificWorkspace } from './workspace';

const must = <T, E>(value: Result<T, E>): T => {
  if (!value.ok) throw Error(JSON.stringify(value.error));
  return value.value;
};
const refName = must(parseRefName('accepted'));
function fixture() {
  const graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('science')),
    acceptedRef: refName,
  });
  const plan = compileScientificWorkspace({ graph, head: null, entries: [] });
  const blobs = new Map<string, Uint8Array>(
    plan.blobs.map((bytes) => [defineBlob(bytes).hash, bytes])
  );
  const readBlob = (blob: { hash: string }) => blobs.get(blob.hash) ?? null;
  const input = {
    graph,
    refName,
    expectedHead: null,
    operationId: must(parseOperationId('initial-setup')),
    mutations: plan.mutations,
    readBlob,
  };
  return { input, blobs, readBlob };
}

it('keeps old scientific request bytes and rejects initialization masquerading as the same ordinary operation', () => {
  const f = fixture(),
    ordinary = applyScientificBatch(f.input);
  expect(ordinary.kind).toBe('changed');
  const before = exportCanonicalClosure(ordinary.graph);
  const receipt = before.records.find((row) => row.kind === 'operation-receipt');
  expect(receipt).toBeDefined();
  expect(JSON.parse(receipt!.canonicalJson).request.validationVersion).toBe(
    'scientific-objects-v1'
  );
  const reused = applyScientificBatch({
    ...f.input,
    graph: ordinary.graph,
    purpose: 'initialize-empty-namespace',
  });
  expect(reused).toMatchObject({ kind: 'rejected', error: { kind: 'operation-id-reused' } });
  expect(exportCanonicalClosure(reused.graph)).toEqual(before);
  const exactOld = applyScientificBatch({ ...f.input, graph: ordinary.graph });
  expect(exactOld.kind).toBe('replay');
  expect(exportCanonicalClosure(exactOld.graph)).toEqual(before);
});

it('replays the original initialization after a later design without replacing newer namespace membership', () => {
  const f = fixture(),
    initial = applyScientificBatch({ ...f.input, purpose: 'initialize-empty-namespace' });
  if (initial.kind !== 'changed') throw Error(JSON.stringify(initial));
  const plan = compileScientificWorkspace({
    graph: initial.graph,
    head: initial.version.id,
    entries: [
      {
        resourceId: must(parseResourceId('new-design')),
        path: must(parseWorkspacePath('design.json')),
        document: {
          formatVersion: 1,
          kind: 'sequence',
          name: 'Design',
          molecule: 'DNA',
          bases: 'ACGT',
          topology: 'linear',
          annotations: [],
          fields: {},
        },
      },
    ],
  });
  for (const bytes of plan.blobs) f.blobs.set(defineBlob(bytes).hash, bytes);
  const later = applyScientificBatch({
    ...f.input,
    graph: initial.graph,
    expectedHead: initial.version.id,
    operationId: must(parseOperationId('new-design-save')),
    mutations: plan.mutations,
  });
  if (later.kind !== 'changed') throw Error(JSON.stringify(later));
  const before = exportCanonicalClosure(later.graph);
  const retry = applyScientificBatch({
    ...f.input,
    graph: later.graph,
    purpose: 'initialize-empty-namespace',
  });
  expect(retry.kind).toBe('replay');
  expect(exportCanonicalClosure(retry.graph)).toEqual(before);
  const current = createScientificReader({
    graph: retry.graph,
    head: later.version.id,
    readBlob: f.readBlob,
  }).current(must(parseResourceId('new-design')));
  expect(current?.document).toMatchObject({ kind: 'sequence', bases: 'ACGT' });
  const wrongPurpose = applyScientificBatch({ ...f.input, graph: later.graph });
  expect(wrongPurpose).toMatchObject({ kind: 'rejected', error: { kind: 'operation-id-reused' } });
  expect(importCanonicalRecords(before).ok).toBe(true);
});
