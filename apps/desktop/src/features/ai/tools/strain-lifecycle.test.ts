import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllowedRendererTool } from '../../agent-bridge/public/renderer-tools';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execOpts } from './test-helpers';

const mocks = vi.hoisted(() => ({ record: vi.fn(), namespace: vi.fn() }));
vi.mock('../../lims/public/record-entity-artifact', async (original) => ({
  ...(await original<typeof import('../../lims/public/record-entity-artifact')>()),
  recordEntityArtifact: mocks.record,
}));
vi.mock('../../../services/read-scientific-namespace', () => ({
  readScientificNamespace: mocks.namespace,
}));

const folders = [
  { id: 'yeast', name: 'Yeast heat recovery', path: '/projects/yeast' },
] as WorkspaceFolder[];

async function invoke(name: string, raw: object, roots = folders) {
  const definition = getAllowedRendererTool(name)!;
  if (definition.execution.kind !== 'sdk') throw new Error('Expected canonical tool factory.');
  const tool = definition.execution.createTool({
    folders: roots,
    actionId: 'strain-action',
    grantedCapabilities: ['read-workspace', 'create-entity'],
  });
  const result = await Reflect.apply(tool.execute!, tool, [definition.inputSchema.parse(raw), execOpts]);
  if (result.ok) definition.outputSchema.parse(result);
  return result;
}

describe('agent planned-strain workflow', () => {
  beforeEach(() => {
    mocks.record.mockReset();
    mocks.namespace.mockReset();
  });
  it('exposes strain creation through the shared, explicit-result tool catalog', () => {
    const definition = getAllowedRendererTool('create_strain');
    expect(definition).toBeDefined();
    expect(definition).toMatchObject({
      required_capabilities: ['read-workspace', 'create-entity'],
      effects: ['mutating'],
      requiresWorkspace: true,
      exposure: { kind: 'shared' },
      execution: { resultContract: 'explicit-v1' },
    });
  });

  it('uses accepted catalog pins and the native writer for planned ancestry and plasmid carriage', async () => {
    mocks.namespace.mockResolvedValue({
      head: 'workspace-version',
      entries: [
        {
          resourceId: 'parent-strain',
          revisionId: 'parent-revision',
          path: 'strains/parent.entity.json',
          lastPath: 'strains/parent.entity.json',
          tombstone: false,
        },
        {
          resourceId: 'pRS416',
          revisionId: 'plasmid-revision',
          path: 'pRS416/sequence.gb',
          lastPath: 'pRS416/sequence.gb',
          tombstone: false,
        },
        { resourceId: 'deleted', revisionId: 'old', path: null, tombstone: true },
      ],
    });
    const catalog = await invoke('list_scientific_objects', {});
    expect(catalog).toMatchObject({
      ok: true,
      enrolled: true,
      workspaceVersionId: 'workspace-version',
    });
    expect(catalog.objects.map((object: { resourceId: string }) => object.resourceId)).toEqual([
      'parent-strain',
      'pRS416',
    ]);
    mocks.record.mockImplementation(async (input) => ({
      artifact: { id: input.id, name: input.name, relationships: input.relationships },
      relativePath: 'strains/assay.entity.json',
      created: true,
      gitCommitted: true,
      acceptedRevision: {
        kind: 'accepted-object',
        resourceId: input.id,
        resourceRevisionId: `rr_${'a'.repeat(64)}`,
        workspaceVersionId: `wv_${'b'.repeat(64)}`,
        contentSha256: 'c'.repeat(64),
        sequenceEditParentEventId: null,
      },
    }));
    const result = await invoke('create_strain', {
      strainId: 'assay',
      name: 'BY4741 empty vector',
      fields: { genotypeCanonical: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0', markers: ['URA3 plasmid'] },
      relationships: [
        {
          type: 'derives_from',
          targetEntityId: 'parent-strain',
          targetRevisionId: 'parent-revision',
          metadata: { step: 'transform pRS416' },
        },
        { type: 'carried_by', targetEntityId: 'pRS416', targetRevisionId: 'plasmid-revision' },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      strainId: 'assay',
      planned: true,
      gitCommitted: true,
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assay',
        kind: 'strain',
        workspaceRoot: '/projects/yeast',
        destinationDir: '/projects/yeast/strains',
        domainStatus: 'planned',
        relationships: [
          {
            type: 'derives_from',
            fromEntityId: 'assay',
            toEntityId: 'parent-strain',
            payload: {
              step: 'transform pRS416',
              assertion: 'planned',
              targetRevisionId: 'parent-revision',
            },
          },
          {
            type: 'carried_by',
            fromEntityId: 'pRS416',
            toEntityId: 'assay',
            payload: { assertion: 'planned', targetRevisionId: 'plasmid-revision' },
          },
        ],
      })
    );
  });

  it('preserves accepted identity and effects when required publication remains pending', async () => {
    const { EntityArtifactAcceptedSavePendingError } =
      await import('../../lims/public/record-entity-artifact');
    mocks.record.mockImplementation(async (input) => {
      throw new EntityArtifactAcceptedSavePendingError(
        '/projects/yeast/strains/assay.entity.json',
        { id: input.id } as never,
        { resourceId: input.id, resourceRevisionId: 'accepted-revision' } as never,
        new Error('Registry reconstruction remains pending.')
      );
    });
    const result = await invoke('create_strain', {
      name: 'assay',
      fields: { genotypeCanonical: 'BY4741' },
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'STRAIN_PUBLICATION_PENDING',
      retriable: true,
      stateChanged: true,
      partialEffects: [
        {
          strainId: result.details.strainId,
          acceptedRevision: { resourceRevisionId: 'accepted-revision' },
        },
      ],
      details: { retryInput: { strainId: result.details.strainId } },
    });
    expect(result.details.retryInput.strainId).toBe(mocks.record.mock.calls[0][0].id);
  });

  it('refuses ambiguous projects, escaped destinations and observed assertions before writing', async () => {
    const raw = { name: 'assay', fields: { genotypeCanonical: 'BY4741' } };
    expect(
      await invoke('create_strain', raw, [
        ...folders,
        { ...folders[0], id: 'other', path: '/projects/other' },
      ])
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(await invoke('create_strain', { ...raw, directory: '../other' })).toMatchObject({
      ok: false,
      stateChanged: false,
    });
    await expect(
      invoke('create_strain', {
        ...raw,
        relationships: [
          { type: 'carried_by', targetEntityId: 'pRS416', metadata: { assertion: 'observed' } },
        ],
      })
    ).rejects.toThrow('Assertion and revision');
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
