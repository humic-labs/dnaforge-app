import { describe, expect, it } from 'vitest';
import {
  createRevisionGraph,
  defineBlob,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { exportCanonicalClosure } from '@waypoint/workspace-revisions/codec';
import {
  applyScientificBatch,
  createScientificReader,
  defineScientificDocument,
  decodeScientificHistory,
  exportScientificHistory,
  serializeScientificHistory,
  validateScientificHistory,
  assertScientificHistoryPredecessorRetained,
} from './index';

const must = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
function history(workspaceId = 'original-logical-project') {
  const blobs = new Map<string, Uint8Array>();
  let graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId(workspaceId)),
    acceptedRef: must(parseRefName('accepted')),
  });
  let head: WorkspaceVersionId | null = null;
  const id = must(parseResourceId('source'));
  let pin: ReturnType<ReturnType<typeof createScientificReader>['current']> = null;
  const snapshots: ReturnType<typeof exportScientificHistory>[] = [];
  for (const [index, bases] of ['ACGTACGT', 'ACGTACGA'].entries()) {
    const document = defineScientificDocument({
      formatVersion: 1,
      kind: 'sequence',
      name: 'Donor',
      molecule: 'DNA',
      bases,
      topology: 'linear',
      annotations: [],
      fields: {},
    });
    blobs.set(document.blob.hash, new TextEncoder().encode(document.text));
    const result = applyScientificBatch({
      graph,
      expectedHead: head,
      refName: must(parseRefName('accepted')),
      operationId: must(parseOperationId(`edit-${index}`)),
      readBlob: (blob) => blobs.get(blob.hash) ?? null,
      mutations: [
        pin
          ? {
              kind: 'edit-resource',
              resourceId: id,
              expectedRevision: pin.revisionId,
              state: document.state,
            }
          : {
              kind: 'create-resource',
              resourceId: id,
              path: must(parseWorkspacePath('source.json')),
              state: document.state,
              origin: { kind: 'created' },
            },
      ],
    });
    if (result.kind !== 'changed') throw new Error('Scientific history fixture failed.');
    graph = result.graph;
    head = result.version.id;
    pin = createScientificReader({
      graph,
      head,
      readBlob: (blob) => blobs.get(blob.hash) ?? null,
    }).current(id);
    snapshots.push(
      exportScientificHistory(graph, { readBlob: (blob) => blobs.get(blob.hash) ?? null })
    );
  }
  const input = { readBlob: (blob: { hash: string }) => blobs.get(blob.hash) ?? null };
  return { graph, head, blobs, input, snapshots, envelope: exportScientificHistory(graph, input) };
}

describe('portable complete scientific authority', () => {
  it('requires every predecessor record and historical blob across accepted-head changes', () => {
    const f = history();
    const previous = f.snapshots[0]!;
    const incoming = f.envelope;
    expect(() => assertScientificHistoryPredecessorRetained({ previous, incoming })).not.toThrow();
    expect(() =>
      assertScientificHistoryPredecessorRetained({ previous: incoming, incoming: previous })
    ).toThrow('record was omitted or changed');
    const record = previous.graph.records[0]!;
    expect(() =>
      assertScientificHistoryPredecessorRetained({
        previous,
        incoming: {
          ...incoming,
          graph: {
            ...incoming.graph,
            records: incoming.graph.records.map((value) =>
              value.id === record.id
                ? { ...value, canonicalJson: value.canonicalJson + ' ' }
                : value
            ),
          },
        },
      })
    ).toThrow('record was omitted or changed');
    const blob = previous.blobs[0]!;
    expect(() =>
      assertScientificHistoryPredecessorRetained({
        previous,
        incoming: {
          ...incoming,
          blobs: incoming.blobs.filter((value) => value.hash !== blob.hash),
        },
      })
    ).toThrow('blob was omitted or changed');
    expect(() =>
      assertScientificHistoryPredecessorRetained({
        previous,
        incoming: {
          ...incoming,
          blobs: incoming.blobs.map((value) =>
            value.hash === blob.hash ? { ...value, byteLength: value.byteLength + 1 } : value
          ),
        },
      })
    ).toThrow('blob was omitted or changed');
    const foreign = history('different-logical-project').envelope;
    expect(() =>
      assertScientificHistoryPredecessorRetained({ previous, incoming: foreign })
    ).toThrow('another logical workspace');
    expect(() =>
      assertScientificHistoryPredecessorRetained({
        previous: incoming,
        incoming: {
          ...incoming,
          graph: { ...incoming.graph, refs: previous.graph.refs },
        },
      })
    ).not.toThrow();
  });
  it('round trips immutable history and refs without renaming or rehashing any identity', () => {
    const f = history(),
      bytes = serializeScientificHistory(f.envelope);
    const installed = decodeScientificHistory(bytes, defineBlob(bytes), f.input);
    expect(installed.head).toBe(f.head);
    expect(exportCanonicalClosure(installed.graph)).toEqual(exportCanonicalClosure(f.graph));
    expect(serializeScientificHistory(installed.envelope)).toEqual(bytes);
    expect(f.envelope.blobs).toHaveLength(2);
  });
  it('refuses a missing historical blob even when every current byte is available', () => {
    const f = history();
    const current = createScientificReader({
      graph: f.graph,
      head: f.head,
      ...f.input,
    }).listCurrent()[0]!;
    const latest = defineBlob(
      new TextEncoder().encode(defineScientificDocument(current.document).text)
    ).hash;
    for (const hash of f.blobs.keys()) if (hash !== latest) f.blobs.delete(hash);
    expect(() => validateScientificHistory(f.envelope, f.input)).toThrow(
      'blob unavailable or corrupt'
    );
  });
  it('rejects an incomplete inventory, foreign workspace, unknown format and corrupt digest', () => {
    const f = history();
    expect(() => validateScientificHistory({ ...f.envelope, blobs: [] }, f.input)).toThrow(
      'inventory'
    );
    expect(() =>
      validateScientificHistory(
        { ...f.envelope, graph: { ...f.envelope.graph, workspaceId: 'other-project' } },
        f.input
      )
    ).toThrow('workspace-id-mismatch');
    expect(() => validateScientificHistory({ ...f.envelope, formatVersion: 2 }, f.input)).toThrow(
      'Unsupported'
    );
    const bytes = serializeScientificHistory(f.envelope);
    expect(() => decodeScientificHistory(bytes, defineBlob(new Uint8Array([1])), f.input)).toThrow(
      'digest'
    );
  });
});
