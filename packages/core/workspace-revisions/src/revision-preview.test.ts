import { expect, it } from 'vitest';
import {
  applyWorkspaceMutation,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  previewMutationRevision,
  type ResourceState,
  type Result,
  type WorkspaceMutation,
} from './index';
import { exportCanonicalClosure } from './codec-public';
const must = <T, E>(value: Result<T, E>): T => {
  if (!value.ok) throw Error(JSON.stringify(value.error));
  return value.value;
};
const id = (value: string) => must(parseResourceId(value));
const path = (value: string) => must(parseWorkspacePath(value));
const refName = must(parseRefName('accepted'));
const state = (text: string) =>
  must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'text.note',
      mediaType: 'text/plain',
      blob: defineBlob(new TextEncoder().encode(text)),
    })
  );

it('predicts exactly the accepted creation, derived copy, edit, move and unchanged-content pins without altering history', () => {
  let graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('preview')),
    acceptedRef: refName,
  });
  let head: import('./identity').WorkspaceVersionId | null = null;
  let serial = 0;
  const accept = (
    mutation: Extract<
      WorkspaceMutation,
      { kind: 'create-resource' | 'edit-resource' | 'edit-and-move-resource' }
    >
  ) => {
    const before = exportCanonicalClosure(graph);
    const predicted = previewMutationRevision(graph, mutation);
    expect(exportCanonicalClosure(graph)).toEqual(before);
    const result = applyWorkspaceMutation({
      graph,
      refName,
      expectedHead: head,
      operationId: must(parseOperationId(`op-${++serial}`)),
      mutation,
    });
    if (result.kind !== 'changed' && result.kind !== 'no-op') throw Error(result.kind);
    graph = result.graph;
    head = result.kind === 'changed' ? result.version.id : result.head;
    expect(
      must(listWorkspaceResources(graph, head!)).find(
        (slot) => slot.resourceId === mutation.resourceId
      )?.revisionId
    ).toBe(predicted);
    return predicted;
  };
  const source = accept({
    kind: 'create-resource',
    resourceId: id('source'),
    path: path('source.txt'),
    state: state('source'),
    origin: { kind: 'created' },
  });
  let copy = accept({
    kind: 'create-resource',
    resourceId: id('copy'),
    path: path('copy.txt'),
    state: state('source'),
    origin: { kind: 'derived', relation: 'copy', sources: [source] },
  });
  copy = accept({
    kind: 'edit-resource',
    resourceId: id('copy'),
    expectedRevision: copy,
    state: state('edited'),
  });
  expect(
    accept({
      kind: 'edit-and-move-resource',
      resourceId: id('copy'),
      expectedRevision: copy,
      expectedPath: path('copy.txt'),
      destination: path('nested/copy.txt'),
      state: state('edited'),
    })
  ).toBe(copy);
  expect(
    accept({
      kind: 'edit-resource',
      resourceId: id('copy'),
      expectedRevision: copy,
      state: state('edited'),
    })
  ).toBe(copy);
  expect(() =>
    previewMutationRevision(graph, {
      kind: 'edit-resource',
      resourceId: id('other'),
      expectedRevision: copy,
      state: state('changed'),
    })
  ).toThrow(/owned/i);
  expect(() =>
    previewMutationRevision(graph, {
      kind: 'create-resource',
      resourceId: id('forged'),
      path: path('forged.txt'),
      state: {} as ResourceState,
      origin: { kind: 'created' },
    })
  ).toThrow(/recognized/i);
});
