import { expect, it, vi } from 'vitest';
import {
  createRevisionGraph,
  inspectWorkspaceResource,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
} from '@waypoint/workspace-revisions';
import { applyScientificBatch, createScientificReaderFamily } from './graph';
import { defineScientificDocument } from './documents';

vi.mock('@waypoint/workspace-revisions', async (original) => {
  const actual = await original<typeof import('@waypoint/workspace-revisions')>();
  return {
    ...actual,
    listWorkspaceResources: vi.fn(actual.listWorkspaceResources),
    inspectWorkspaceResource: vi.fn(actual.inspectWorkspaceResource),
  };
});

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw Error(JSON.stringify(result.error));
  return result.value;
};

it('reuses historical namespace reads within a family and isolates different heads and families', () => {
  const refName = must(parseRefName('accepted'));
  const graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('reader-family')),
    acceptedRef: refName,
  });
  const defined = defineScientificDocument({
    formatVersion: 1,
    kind: 'primer',
    name: 'Retained primer',
    molecule: 'DNA',
    bases: 'ACGTTAGCCTGATCGTAC',
    modifications: [],
    fields: {},
  });
  const resourceId = must(parseResourceId('primer'));
  const path = must(parseWorkspacePath('primer.json'));
  const readBlob = () => new TextEncoder().encode(defined.text);
  const first = applyScientificBatch({
    graph,
    refName,
    expectedHead: null,
    operationId: must(parseOperationId('create-primer')),
    mutations: [
      {
        kind: 'create-resource',
        resourceId,
        path,
        state: defined.state,
        origin: { kind: 'created' },
      },
    ],
    readBlob,
  });
  if (first.kind !== 'changed') throw Error(first.kind);
  const retained = createScientificReaderFamily({ graph: first.graph, readBlob });
  const removed = applyScientificBatch({
    graph: first.graph,
    refName,
    expectedHead: first.version.id,
    operationId: must(parseOperationId('remove-primer')),
    mutations: [
      {
        kind: 'remove-membership',
        resourceId,
        expectedPath: path,
        expectedRevision: retained.at(first.version.id).current(resourceId)!.revisionId,
      },
    ],
    readBlob,
  });
  if (removed.kind !== 'changed') throw Error(removed.kind);
  const family = createScientificReaderFamily({ graph: removed.graph, readBlob });
  vi.mocked(listWorkspaceResources).mockClear();
  vi.mocked(inspectWorkspaceResource).mockClear();
  for (let index = 0; index < 12; index += 1) {
    const historical = family.at(first.version.id).listCurrent();
    expect(historical.map((entry) => entry.document)).toEqual([defined.document]);
    expect(Object.isFrozen(historical)).toBe(true);
    expect(family.at(removed.version.id).listCurrent()).toEqual([]);
    expect(family.at(null).listCurrent()).toEqual([]);
  }
  expect(listWorkspaceResources).toHaveBeenCalledTimes(2);
  expect(inspectWorkspaceResource).toHaveBeenCalledTimes(0);
  expect(retained.at(first.version.id).listCurrent()).toHaveLength(1);
  expect(listWorkspaceResources).toHaveBeenCalledTimes(3);
  expect(family.at(removed.version.id).current(resourceId)).toBeNull();
  expect(family.at(first.version.id).current(resourceId)?.document).toEqual(defined.document);
});
