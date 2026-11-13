import { describe, expect, it } from 'vitest';

import {
  applyWorkspaceMutation,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseResourceLocator,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspaceLocator,
  parseWorkspacePath,
  resolveResourceLocator,
  resolveWorkspaceLocator,
  type Result,
} from './index';

const MAIN_REF = must(parseRefName('main'));

describe('URL-neutral stable locator boundary', () => {
  it('parses unpinned and pinned locator fields without caller casts', () => {
    const history = resourceHistory();
    expect(parseWorkspaceLocator({ workspaceId: 'locator-workspace' })).toEqual({
      ok: true,
      value: { workspaceId: 'locator-workspace' },
    });
    expect(
      parseWorkspaceLocator({
        workspaceId: 'locator-workspace',
        versionId: history.created.version.id,
      })
    ).toEqual({
      ok: true,
      value: {
        workspaceId: 'locator-workspace',
        versionId: history.created.version.id,
      },
    });
    expect(
      parseResourceLocator({
        workspaceId: 'locator-workspace',
        resourceId: 'stable-resource',
        revisionId: history.createdRevision,
      })
    ).toEqual({
      ok: true,
      value: {
        workspaceId: 'locator-workspace',
        resourceId: 'stable-resource',
        revisionId: history.createdRevision,
      },
    });
    expect(
      parseResourceLocator({
        workspaceId: 'locator-workspace',
        resourceId: 'stable-resource',
        revisionId: 'rr_bad',
      })
    ).toEqual({ ok: false, error: { kind: 'invalid-resource-revision-id' } });
  });

  it('resolves an unpinned resource through the accepted ref and a pin through history', () => {
    const history = resourceHistory();
    const workspaceLocator = must(parseWorkspaceLocator({ workspaceId: 'locator-workspace' }));
    const workspace = resolveWorkspaceLocator({
      graph: history.edited.graph,
      locator: workspaceLocator,
      acceptedRef: MAIN_REF,
    });
    expect(workspace).toEqual({ ok: true, value: history.edited.version });

    const current = resolveResourceLocator({
      graph: history.edited.graph,
      locator: must(
        parseResourceLocator({
          workspaceId: 'locator-workspace',
          resourceId: 'stable-resource',
        })
      ),
      acceptedRef: MAIN_REF,
    });
    expect(current.ok && current.value.revision.id).toBe(history.editedRevision);
    expect(current.ok && current.value.workspaceVersionId).toBe(history.edited.version.id);

    const pinned = resolveResourceLocator({
      graph: history.edited.graph,
      locator: must(
        parseResourceLocator({
          workspaceId: 'locator-workspace',
          resourceId: 'stable-resource',
          revisionId: history.createdRevision,
        })
      ),
      acceptedRef: MAIN_REF,
    });
    expect(pinned.ok && pinned.value.revision.id).toBe(history.createdRevision);
    expect(pinned.ok && pinned.value.workspaceVersionId).toBe(null);
  });
});

function resourceHistory() {
  const graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('locator-workspace')),
    acceptedRef: MAIN_REF,
  });
  const resourceId = must(parseResourceId('stable-resource'));
  const state = (contents: string) =>
    must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'text.note',
        mediaType: 'text/plain',
        blob: defineBlob(new TextEncoder().encode(contents)),
      })
    );
  const created = applyWorkspaceMutation({
    graph,
    refName: MAIN_REF,
    expectedHead: null,
    operationId: must(parseOperationId('locator-create')),
    mutation: {
      kind: 'create-resource',
      resourceId,
      path: must(parseWorkspacePath('stable.txt')),
      state: state('v1'),
      origin: { kind: 'created' },
    },
  });
  if (created.kind !== 'changed') throw new Error('Expected locator create.');
  const createdRevision = must(listWorkspaceResources(created.graph, created.version.id))[0]
    ?.revisionId;
  if (!createdRevision) throw new Error('Expected locator root revision.');
  const edited = applyWorkspaceMutation({
    graph: created.graph,
    refName: MAIN_REF,
    expectedHead: created.version.id,
    operationId: must(parseOperationId('locator-edit')),
    mutation: {
      kind: 'edit-resource',
      resourceId,
      expectedRevision: createdRevision,
      state: state('v2'),
    },
  });
  if (edited.kind !== 'changed') throw new Error('Expected locator edit.');
  const editedRevision = must(listWorkspaceResources(edited.graph, edited.version.id))[0]
    ?.revisionId;
  if (!editedRevision) throw new Error('Expected locator child revision.');
  return { created, edited, createdRevision, editedRevision };
}

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}
