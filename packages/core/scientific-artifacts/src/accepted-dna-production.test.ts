import { expect, it } from 'vitest';
import {
  createRevisionGraph,
  defineBlob,
  parseWorkspaceId,
  parseRefName,
  parseResourceId,
  parseWorkspacePath,
  parseOperationId,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  applyScientificBatch,
  createScientificReader,
  defineScientificFile,
  exportScientificHistory,
} from '@waypoint/scientific-objects';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { scientificNativeCodecs } from './native-codecs';
import { nativeScientificHistoryReader } from './history';
import {
  verifyAcceptedDnaProductionWitness,
  inspectAcceptedDnaProductionSelection,
  type AcceptedDnaProductionWitness,
} from './accepted-dna-production';
const must = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!value.ok) throw Error(JSON.stringify(value.error));
  return value.value;
};
function fixture() {
  const workspace = must(parseWorkspaceId('logical-science')),
    refName = must(parseRefName('accepted')),
    resourceId = must(parseResourceId('design'));
  let graph = createRevisionGraph({ workspaceId: workspace, acceptedRef: refName }),
    head: WorkspaceVersionId | null = null,
    serial = 0;
  const bodies = new Map<string, Uint8Array>(),
    readBlob = (blob: { hash: string }) => bodies.get(blob.hash) ?? null;
  const add = (id: string, bases: string) => {
    const key = must(parseResourceId(id)),
      current = createScientificReader({
        graph,
        head,
        readBlob,
        codecs: scientificNativeCodecs,
      }).current(key);
    const text = serializeGenBank({
      id,
      name: id,
      sequence: bases,
      length: bases.length,
      circular: false,
      annotations: [],
    });
    const defined = defineScientificFile(
      { representation: { format: 'genbank-v1', text } },
      scientificNativeCodecs
    );
    bodies.set(defined.blob.hash, new TextEncoder().encode(text));
    const result = applyScientificBatch({
      graph,
      expectedHead: head,
      refName,
      operationId: must(parseOperationId('change-' + ++serial)),
      readBlob,
      codecs: scientificNativeCodecs,
      mutations: [
        current
          ? {
              kind: 'edit-resource',
              resourceId: key,
              expectedRevision: current.revisionId,
              state: defined.state,
            }
          : {
              kind: 'create-resource',
              resourceId: key,
              path: must(parseWorkspacePath(id + '.gb')),
              state: defined.state,
              origin: { kind: 'created' },
            },
      ],
    });
    if (result.kind !== 'changed') throw Error(JSON.stringify(result));
    graph = result.graph;
    head = result.version.id;
    return text;
  };
  add('design', 'ACGT');
  const snapshot = () =>
    createScientificReader({ graph, head, readBlob, codecs: scientificNativeCodecs }).current(
      resourceId
    )!;
  const first = snapshot(),
    selection = {
      scientificWorkspaceId: workspace,
      revision: {
        kind: 'accepted-object' as const,
        resourceId,
        resourceRevisionId: first.revisionId,
        workspaceVersionId: head!,
        contentSha256: defineBlob(new TextEncoder().encode(first.representation!.text)).hash.slice(
          7
        ),
      },
    },
    owner = {
      projectId: 'local-project',
      workspaceScope: 'local-project',
      scientificWorkspaceId: workspace,
    };
  const witness = (): AcceptedDnaProductionWitness => {
    const history = exportScientificHistory(graph, nativeScientificHistoryReader(readBlob));
    return {
      schema: 'dnaforge.accepted-dna-production-witness.v1',
      owner,
      selection,
      history,
      blobs: history.blobs.map((blob) => ({
        blob,
        body: { encoding: 'base64', value: btoa(String.fromCharCode(...readBlob(blob)!)) },
      })),
    };
  };
  return { add, witness, selection, owner, current: () => ({ graph, head, readBlob }) };
}
it('verifies native DNA from the complete accepted closure and refuses altered, missing and noncanonical retained bodies', () => {
  const f = fixture(),
    w = f.witness();
  expect(verifyAcceptedDnaProductionWitness(w).binding.document).toMatchObject({
    length: 4,
    molecule: 'DNA',
  });
  for (const mutate of [
    (v: any) => v.blobs.pop(),
    (v: any) => (v.blobs[0].body.value = 'AAAA'),
    (v: any) => (v.selection.revision.contentSha256 = '0'.repeat(64)),
    (v: any) => (v.owner.scientificWorkspaceId = 'foreign'),
    (v: any) => (v.extra = true),
    (v: any) => v.blobs.push(v.blobs[0]),
  ]) {
    const bad = JSON.parse(JSON.stringify(w));
    mutate(bad);
    expect(() => verifyAcceptedDnaProductionWitness(bad)).toThrow();
  }
});
it('permits an unrelated accepted advance and refuses changed current DNA or a detached selected workspace version', () => {
  const f = fixture(),
    old = verifyAcceptedDnaProductionWitness(f.witness());
  f.add('unrelated', 'GGCC');
  expect(verifyAcceptedDnaProductionWitness(f.witness()).binding).toEqual(old.binding);
  expect(
    inspectAcceptedDnaProductionSelection({
      ...f.current(),
      owner: f.owner,
      selection: f.selection,
      requiredAcceptedAncestor: old.capturedAcceptedHead,
    }).binding
  ).toEqual(old.binding);
  f.add('design', 'ACGA');
  expect(() => verifyAcceptedDnaProductionWitness(f.witness())).toThrow();
  const detached = fixture(),
    first = detached.witness();
  detached.add('unrelated', 'GG');
  const bad = JSON.parse(JSON.stringify(detached.witness())) as AcceptedDnaProductionWitness;
  const newHead = bad.history.graph.refs.find((row) => row.name === 'accepted')!.head;
  const accepted = bad.history.graph.refs.find((row) => row.name === 'accepted')!;
  (accepted as { head: string }).head = first.selection.revision.workspaceVersionId;
  (bad.selection.revision as { workspaceVersionId: string }).workspaceVersionId = newHead!;
  expect(() => verifyAcceptedDnaProductionWitness(bad)).toThrow();
});
