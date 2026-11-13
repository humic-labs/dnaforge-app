import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execTool } from './test-helpers';
import { assertMcpOutput, checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
import type { LimsEntity, LimsRegistrySummary, LimsRegistryPreview } from '../../../shared/lims';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../../shared/entity-schema';
import type { ToolFailure } from '../../agent-bridge/public/tool-result';
import { registryRepresentationForEntity } from '../../../shared/registry-entity-opening';
import { PRIMER_ARTIFACT_SCHEMA } from '../../../shared/primer-artifact-schema';

const mocks = vi.hoisted(() => ({
  queryLimsEntities: vi.fn(),
  queryLimsRegistrySummaries: vi.fn(),
  getLimsRegistryPreview: vi.fn(),
  getLimsEntityById: vi.fn(),
  resolveLimsEntityOpenTarget: vi.fn(),
  openLimsEntity: vi.fn(),
  navigateToRegistryEntity: vi.fn(),
}));
vi.mock('../../lims/operations', () => ({
  queryLimsEntities: mocks.queryLimsEntities,
  queryLimsRegistrySummaries: mocks.queryLimsRegistrySummaries,
  getLimsRegistryPreview: mocks.getLimsRegistryPreview,
}));
vi.mock('../../lims/open-target', () => ({
  getLimsEntityById: mocks.getLimsEntityById,
  resolveLimsEntityOpenTarget: mocks.resolveLimsEntityOpenTarget,
}));
vi.mock('../../lims/open-entity', () => ({
  openLimsEntity: mocks.openLimsEntity,
  isLimsEntityOpened: (result: { status: string }) => result.status.startsWith('opened'),
}));
vi.mock('../../lims/public/registry-presentation', () => ({
  navigateToRegistryEntity: mocks.navigateToRegistryEntity,
}));

import {
  limsGetEntityTool,
  limsGetEntityOutputSchema,
  limsGetRegistryPreviewTool,
  limsGetRegistryPreviewOutputSchema,
  limsOpenEntityTool as uncheckedLimsOpenEntityTool,
  limsOpenEntitySchema,
  limsOpenEntityOutputSchema,
  limsQueryEntitiesTool,
  limsQueryEntitiesOutputSchema,
  limsQueryRegistrySummariesTool,
  limsQueryRegistrySummariesOutputSchema,
  limsQueryRegistrySummariesSchema,
  limsResolveOpenTargetTool,
  limsResolveOpenTargetOutputSchema,
} from './lims';

const limsOpenEntityTool = checkedToolFactory(
  () => uncheckedLimsOpenEntityTool,
  limsOpenEntityOutputSchema
)();

const entityId = 'demo-dna509-plasmid-puc19';
const molecularDocumentTarget = {
  kind: 'molecular_document' as const,
  entityId,
  entityKind: 'molecular-document',
  label: 'Saved molecular view',
};
const schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot = {
  schemaId: 'schema-entity-plasmid',
  schemaRevisionId: 'schema-entity-plasmid-v1',
  name: 'plasmid',
  displayName: 'Plasmid',
  baseKind: 'sequence',
  version: 1,
  fields: [{ key: 'markers', label: 'Markers', type: 'string_array' }],
};
const sequenceTarget = {
  kind: 'sequence_file' as const,
  entityId,
  entityKind: 'plasmid',
  label: 'pUC19',
  documentId: 'document-puc19',
  registrationStatus: 'registered' as const,
  sequence: {
    topology: 'circular' as const,
    length: 2686,
    contentHash: 'sha256:aaa',
    sourceFormat: 'gb' as const,
  },
};

function makePlasmidEntity(): LimsEntity {
  return {
    id: entityId,
    kind: 'plasmid',
    schemaId: schemaSnapshot.schemaId,
    schemaRevisionId: schemaSnapshot.schemaRevisionId,
    name: 'pUC19',
    registryId: 'p000123',
    fields: {
      sequence: {
        mode: 'file',
        documentId: 'document-puc19',
        relPath: '/fixtures/pUC19.gb',
        topology: 'circular',
        length: 2686,
        contentHash: 'sha256:aaa',
        sourceFormat: 'gb',
      },
      markers: ['AmpR'],
    },
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: null,
    actor: 'test',
    eventSeq: null,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}
function makeSummary(): LimsRegistrySummary {
  return {
    id: entityId,
    kind: 'plasmid',
    schemaSnapshot,
    fieldValues: { markers: ['AmpR'] },
    name: 'pUC19',
    registryId: 'p000123',
    registrationStatus: 'registered',
    domainStatus: null,
    representation: {
      kind: 'file_sequence',
      label: 'Circular DNA sequence',
      canOpen: true,
      openTarget: sequenceTarget,
    },
    summary: 'Circular plasmid, 2686 bp',
    sequenceSummary: { topology: 'circular', length: 2686, sourceFormat: 'gb' },
    linkSummary: { outgoingCount: 0, incomingCount: 0, notable: [] },
    searchableText: 'pUC19 plasmid',
    updatedAt: 1,
    archived: false,
  };
}
function makePreview(): LimsRegistryPreview {
  return {
    entity: makePlasmidEntity(),
    summary: makeSummary(),
    schemaSnapshot,
    outgoingLinks: [],
    incomingLinks: [],
  };
}

describe('LIMS AI tools', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it('queries typed entities, preserving extensible values and removing private sequence locators', async () => {
    mocks.queryLimsEntities.mockResolvedValueOnce([makePlasmidEntity()]);
    const input = { kind: 'plasmid', nameLike: 'pUC19', limit: 25 };
    const result = await execTool(limsQueryEntitiesTool, input);
    assertMcpOutput(limsQueryEntitiesOutputSchema, result);
    expect(result).toMatchObject({
      ok: true,
      count: 1,
      entities: [{ fields: { markers: ['AmpR'], sequence: { documentId: 'document-puc19' } } }],
    });
    expect(JSON.stringify(result)).not.toContain('/fixtures/pUC19.gb');
    expect(mocks.queryLimsEntities).toHaveBeenCalledWith(input);
  });

  it('queries paginated registry summaries with their immutable schema and representation', async () => {
    const page = {
      summaries: [makeSummary()],
      totalCount: 1,
      limit: 25,
      offset: 0,
      availableOrganisms: [{ speciesTaxid: '562', speciesName: 'Escherichia coli', count: 2 }],
    };
    mocks.queryLimsRegistrySummaries.mockResolvedValueOnce(page);
    const input = { search: 'pUC19', representationKind: 'file_sequence', limit: 25 };
    const result = await execTool(limsQueryRegistrySummariesTool, input);
    assertMcpOutput(limsQueryRegistrySummariesOutputSchema, result);
    expect(result).toEqual({ ...page, ok: true });
    expect(mocks.queryLimsRegistrySummaries).toHaveBeenCalledWith(input);
  });

  it('inspects a registry preview with typed links and genome evidence', async () => {
    const preview = makePreview();
    preview.incomingLinks = [
      {
        link: {
          id: 'link1',
          fromEntityId: 'strain1',
          toEntityId: entityId,
          type: 'associated_with',
          payload: { label: 'source' },
          workspaceId: null,
          actor: null,
          eventSeq: null,
          tombstone: false,
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        },
        entity: {
          id: 'strain1',
          name: 'Strain',
          kind: 'strain',
          registrationStatus: 'tracked',
          domainStatus: null,
        },
        summary: makeSummary(),
      },
    ];
    preview.strainGenomeSummary = {
      strain: makePlasmidEntity(),
      parentGenome: null,
      hypothesisGenome: null,
      verifiedGenome: null,
      parentLink: null,
      hypothesisLink: null,
      verifiedLink: null,
      gap: { status: 'no_hypothesis', message: 'No hypothesis is attached.' },
    };
    preview.nativeRecord = { schemaSnapshot };
    preview.originalSource = {
      workspaceId: 1,
      entityId,
      sourceRecordId: 'original1',
      kind: 'reviewed_table_row',
    };
    mocks.getLimsRegistryPreview.mockResolvedValueOnce(preview);
    const result = await execTool(limsGetRegistryPreviewTool, { entityId });
    assertMcpOutput(limsGetRegistryPreviewOutputSchema, result);
    expect(result).toMatchObject({
      ok: true,
      incomingLinks: [{ link: { type: 'associated_with' } }],
    });
    expect(mocks.getLimsRegistryPreview).toHaveBeenCalledWith({ entityId });
  });

  it('reads one entity by id, including its complete record metadata', async () => {
    mocks.getLimsEntityById.mockResolvedValueOnce(makePlasmidEntity());
    const result = await execTool(limsGetEntityTool, { entityId });
    assertMcpOutput(limsGetEntityOutputSchema, result);
    expect(result).toMatchObject({
      ok: true,
      entityId,
      found: true,
      entity: { registryId: 'p000123' },
    });
  });

  it('resolves an open target without changing the UI', async () => {
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(sequenceTarget);
    const result = await execTool(limsResolveOpenTargetTool, { entityId });
    assertMcpOutput(limsResolveOpenTargetOutputSchema, result);
    expect(result).toEqual({ ok: true, target: sequenceTarget });
    expect(mocks.resolveLimsEntityOpenTarget).toHaveBeenCalledWith(entityId);
  });

  it('preserves molecular-document registry summaries in the public response', async () => {
    const summary = {
      ...makeSummary(),
      representation: {
        kind: 'molecular_document' as const,
        label: 'Saved molecular view',
        canOpen: true,
        openTarget: molecularDocumentTarget,
      },
    } satisfies LimsRegistrySummary;
    const page = { summaries: [summary], totalCount: 1, limit: 25, offset: 0 };
    mocks.queryLimsRegistrySummaries.mockResolvedValueOnce(page);
    const input = { representationKind: 'molecular_document', limit: 25 };
    expect(limsQueryRegistrySummariesSchema.parse(input)).toEqual(input);
    const result = await execTool(limsQueryRegistrySummariesTool, input);
    assertMcpOutput(limsQueryRegistrySummariesOutputSchema, result);
    expect(result).toEqual({ ...page, ok: true });
    expect(mocks.queryLimsRegistrySummaries).toHaveBeenCalledWith(input);
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(molecularDocumentTarget);
    const target = await execTool(limsResolveOpenTargetTool, { entityId });
    assertMcpOutput(limsResolveOpenTargetOutputSchema, target);
    expect(target).toEqual({ ok: true, target: molecularDocumentTarget });
  });

  it.each([
    { status: 'opened_molecular_document', target: molecularDocumentTarget },
    {
      status: 'opened_record',
      target: {
        kind: 'record_detail',
        entityId,
        entityKind: 'reagent',
        label: 'Reviewed reagent',
        reason: 'no_primary_representation',
      },
    },
    { status: 'opened', target: sequenceTarget },
    {
      status: 'opened',
      target: {
        kind: 'managed_sequence',
        entityId,
        entityKind: 'plasmid',
        label: 'pUC19',
        registrationStatus: 'registered',
        document: {
          kind: 'managed-sequence',
          packageId: 'package1',
          packageRoot: '/private/package',
        },
      },
    },
    {
      status: 'opened_protein',
      target: {
        kind: 'protein_sequence',
        entityId,
        entityKind: 'protein',
        label: 'Protein',
        registrationStatus: 'registered',
      },
    },
    {
      status: 'opened_notebook',
      target: { kind: 'notebook', entityId, entityKind: 'notebook', label: 'Notebook' },
    },
    {
      status: 'opened_track_view',
      target: { kind: 'track_view', entityId, entityKind: 'track-view', label: 'Tracks' },
    },
  ])('opens registry representation $status with a typed receipt', async (receipt) => {
    mocks.openLimsEntity.mockResolvedValueOnce({ ...receipt, tabId: 'tab1' });
    const result = await execTool(limsOpenEntityTool, { entityId });
    assertMcpOutput(limsOpenEntityOutputSchema, result);
    expect(result).toMatchObject({ ok: true, status: receipt.status, tabId: 'tab1' });
    expect(JSON.stringify(result)).not.toContain('/private/package');
    expect(mocks.openLimsEntity).toHaveBeenCalledWith({ entityId, strategy: { kind: 'smart' } });
  });

  it.each(['strain', 'organism', 'custom_record'])(
    'preserves the native saved %s target across advertised resolution and opening',
    async (kind) => {
      const target = registryRepresentationForEntity({
        ...makePlasmidEntity(),
        kind,
        workspaceId: 7,
        fields: {
          artifact: { schema: 'waypoint.entity.v2', relativePath: 'records/saved.entity.json' },
        },
      }).openTarget;
      expect(target.kind).toBe('record_file');
      mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
      const resolved = await execTool(limsResolveOpenTargetTool, { entityId });
      assertMcpOutput(limsResolveOpenTargetOutputSchema, resolved);
      expect(resolved).toEqual({ ok: true, target });
      mocks.openLimsEntity.mockResolvedValueOnce({ status: 'opened_record', tabId: 'record-tab', target });
      const opened = await execTool(limsOpenEntityTool, { entityId });
      assertMcpOutput(limsOpenEntityOutputSchema, opened);
      expect(opened).toEqual({ ok: true, status: 'opened_record', tabId: 'record-tab', target });
    }
  );

  it.each([7, null])('preserves the saved oligo target with workspace %s', async (workspaceId) => {
    const representation = registryRepresentationForEntity({
      ...makePlasmidEntity(),
      kind: 'oligo',
      workspaceId,
      fields: {
        artifact: { schema: PRIMER_ARTIFACT_SCHEMA, relativePath: 'records/saved.primer.json' },
      },
    });
    const target = {
      kind: 'primer',
      entityId,
      entityKind: 'oligo',
      label: 'pUC19',
      workspaceId,
      artifactRelativePath: 'records/saved.primer.json',
    };
    expect(representation).toMatchObject({ kind: 'primer', canOpen: true, openTarget: target });

    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(representation.openTarget);
    const resolved = await execTool(limsResolveOpenTargetTool, { entityId });
    assertMcpOutput(limsResolveOpenTargetOutputSchema, resolved);
    expect(resolved).toEqual({ ok: true, target });

    const receipt = { status: 'opened_primer', tabId: 'oligo-tab', target };
    mocks.openLimsEntity.mockResolvedValueOnce({ ...receipt, target: representation.openTarget });
    const opened = await execTool(limsOpenEntityTool, { entityId });
    expect(opened).toEqual({ ok: true, ...receipt });

    const page = {
      summaries: [{ ...makeSummary(), kind: 'oligo', representation }],
      totalCount: 1,
      limit: 25,
      offset: 0,
    };
    mocks.queryLimsRegistrySummaries.mockResolvedValueOnce(page);
    const summaries = await execTool(limsQueryRegistrySummariesTool, {});
    assertMcpOutput(limsQueryRegistrySummariesOutputSchema, summaries);
    expect(summaries).toEqual({ ok: true, ...page });
  });

  it.each([
    { workspaceId: '7' },
    { workspaceId: 1.5 },
    { workspaceId: undefined },
    { artifactRelativePath: undefined },
    { artifactRelativePath: 7 },
  ])('rejects malformed saved record target fields: %j', (patch) => {
    const target = { kind: 'record_file', entityId, entityKind: 'strain', label: 'Saved record', workspaceId: 7, artifactRelativePath: 'records/saved.entity.json', ...patch };
    expect(() => assertMcpOutput(limsResolveOpenTargetOutputSchema, { ok: true, target }))
      .toThrow('MCP output contract rejected');
    expect(() => assertMcpOutput(limsOpenEntityOutputSchema, { ok: true, status: 'opened_record', tabId: 'record-tab', target }))
      .toThrow('MCP output contract rejected');
  });

  it.each(['strain', 'organism', 'custom_record'])(
    'preserves the native saved %s representation in summary and preview results',
    async (kind) => {
      const entity = {
        ...makePlasmidEntity(),
        kind,
        workspaceId: 7,
        fields: {
          artifact: { schema: 'waypoint.entity.v2', relativePath: 'records/saved.entity.json' },
        },
      };
      const representation = registryRepresentationForEntity(entity);
      expect(representation.kind).toBe('record_file');
      const summary = { ...makeSummary(), kind, representation };
      mocks.queryLimsRegistrySummaries.mockResolvedValueOnce({
        summaries: [summary], totalCount: 1, limit: 25, offset: 0,
      });
      const queried = await execTool(limsQueryRegistrySummariesTool, {});
      assertMcpOutput(limsQueryRegistrySummariesOutputSchema, queried);
      expect(queried).toMatchObject({ summaries: [{ id: entity.id, representation }] });
      mocks.getLimsRegistryPreview.mockResolvedValueOnce({
        ...makePreview(), entity, summary,
      });
      const preview = await execTool(limsGetRegistryPreviewTool, { entityId: entity.id });
      assertMcpOutput(limsGetRegistryPreviewOutputSchema, preview);
      expect(preview).toMatchObject({ entity, summary: { representation } });
      expect(() => assertMcpOutput(limsQueryRegistrySummariesOutputSchema, {
        ok: true, summaries: [{ ...summary, representation: { ...representation, canOpen: 'yes' } }],
        totalCount: 1, limit: 25, offset: 0,
      })).toThrow('MCP output contract rejected');
    }
  );

  it('keeps empty queries, absent records, and missing-target resolution successful', async () => {
    mocks.queryLimsEntities.mockResolvedValueOnce([]);
    const entities = await execTool(limsQueryEntitiesTool, {});
    assertMcpOutput(limsQueryEntitiesOutputSchema, entities);
    expect(entities).toEqual({ ok: true, count: 0, entities: [] });
    mocks.queryLimsRegistrySummaries.mockResolvedValueOnce({
      summaries: [],
      totalCount: 0,
      limit: 25,
      offset: 0,
    });
    const summaries = await execTool(limsQueryRegistrySummariesTool, {});
    assertMcpOutput(limsQueryRegistrySummariesOutputSchema, summaries);
    expect(summaries).toMatchObject({ ok: true, summaries: [] });
    mocks.getLimsEntityById.mockResolvedValueOnce(null);
    const entity = await execTool(limsGetEntityTool, { entityId: 'missing' });
    assertMcpOutput(limsGetEntityOutputSchema, entity);
    expect(entity).toEqual({ ok: true, entityId: 'missing', found: false, entity: null });
    const target = {
      kind: 'missing_entity',
      entityId: 'missing',
      label: 'missing',
      reason: 'not_found',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    const resolution = await execTool(limsResolveOpenTargetTool, { entityId: 'missing' });
    assertMcpOutput(limsResolveOpenTargetOutputSchema, resolution);
    expect(resolution).toEqual({ ok: true, target });
  });

  it.each([
    ['queryLimsEntities', limsQueryEntitiesTool, {}, 'LIMS_QUERY_ENTITIES_FAILED'],
    [
      'queryLimsRegistrySummaries',
      limsQueryRegistrySummariesTool,
      {},
      'LIMS_QUERY_SUMMARIES_FAILED',
    ],
    ['getLimsRegistryPreview', limsGetRegistryPreviewTool, { entityId }, 'LIMS_GET_PREVIEW_FAILED'],
    ['getLimsEntityById', limsGetEntityTool, { entityId }, 'LIMS_GET_ENTITY_FAILED'],
    [
      'resolveLimsEntityOpenTarget',
      limsResolveOpenTargetTool,
      { entityId },
      'LIMS_RESOLVE_OPEN_TARGET_FAILED',
    ],
  ] as const)(
    'reports $0 read failures without suggesting that state changed',
    async (mockName, tool, input, code) => {
      mocks[mockName].mockRejectedValueOnce(new Error('Registry is unavailable'));
      await expect(execTool(tool, input)).resolves.toEqual({
        ok: false,
        code,
        error: 'Registry is unavailable',
        retriable: false,
        stateChanged: false,
        partialEffects: [],
      });
    }
  );

  it.each([
    {
      status: 'not_found',
      code: 'LIMS_ENTITY_NOT_FOUND',
      stateChanged: false,
      target: { kind: 'missing_entity', entityId, label: 'Missing', reason: 'not_found' },
    },
    {
      status: 'unsupported',
      code: 'REGISTRY_NOT_PRESENTED',
      stateChanged: 'unknown',
      target: {
        kind: 'record_detail',
        entityId,
        entityKind: 'strain',
        label: 'Strain',
        reason: 'strain_evidence',
      },
    },
    {
      status: 'not_opened',
      code: 'LIMS_ENTITY_NOT_OPENED',
      stateChanged: 'unknown',
      target: sequenceTarget,
    },
  ])(
    'reports opening outcome $status explicitly',
    async ({ status, code, stateChanged, target }) => {
      if (status === 'unsupported')
        mocks.navigateToRegistryEntity.mockResolvedValueOnce({ status: 'blocked', entityId });
      mocks.openLimsEntity.mockResolvedValueOnce({
        status,
        target,
        message: 'Could not present this record',
      });
      const result = await execTool<ToolFailure>(limsOpenEntityTool, { entityId });
      expect(result).toMatchObject({
        ok: false,
        code,
        stateChanged,
        partialEffects: [],
        details: { status, target },
      });
    }
  );

  it('does not claim that a thrown opener left the UI unchanged', async () => {
    mocks.openLimsEntity.mockRejectedValueOnce(new Error('Opener disconnected'));
    await expect(execTool(limsOpenEntityTool, { entityId })).resolves.toEqual({
      ok: false,
      code: 'LIMS_OPEN_ENTITY_FAILED',
      error: 'Opener disconnected',
      retriable: false,
      stateChanged: 'unknown',
      partialEffects: [],
    });
  });

  it('rejects malformed nested domain payloads using the external MCP client validator', () => {
    expect(() =>
      assertMcpOutput(limsQueryEntitiesOutputSchema, {
        ok: true,
        count: 1,
        entities: [{ ...makePlasmidEntity(), registrationStatus: 'made_up' }],
      })
    ).toThrow('MCP output contract rejected');
    expect(() =>
      assertMcpOutput(limsQueryRegistrySummariesOutputSchema, {
        ok: true,
        totalCount: 1,
        limit: 25,
        offset: 0,
        summaries: [
          {
            ...makeSummary(),
            representation: { kind: 'file_sequence', label: 'Sequence', canOpen: 'yes' },
          },
        ],
      })
    ).toThrow('MCP output contract rejected');
    expect(() =>
      assertMcpOutput(limsGetRegistryPreviewOutputSchema, {
        ...makePreview(),
        ok: true,
        incomingLinks: [{ link: { type: 'associated_with' } }],
      })
    ).toThrow('MCP output contract rejected');
    expect(() =>
      assertMcpOutput(limsGetEntityOutputSchema, {
        ok: true,
        entityId,
        found: true,
        entity: null,
      })
    ).toThrow('MCP output contract rejected');
    expect(() =>
      assertMcpOutput(limsResolveOpenTargetOutputSchema, {
        ok: true,
        target: { ...sequenceTarget, sequence: { ...sequenceTarget.sequence, length: '2686' } },
      })
    ).toThrow('MCP output contract rejected');
    expect(() =>
      assertMcpOutput(limsOpenEntityOutputSchema, {
        ok: true,
        status: 'opened',
        tabId: 'tab1',
        target: { kind: 'missing_entity' },
      })
    ).toThrow('MCP output contract rejected');
  });
});


describe('LIMS Registry presentation contract', () => {
  beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); });
  it('presents detail-only records through the same human Registry owner as workspace opening', async () => {
    const target = { entityId: 'ws1::strain', label: 'Native strain', kind: 'record_detail' };
    mocks.openLimsEntity.mockResolvedValue({
      status: 'unsupported',
      target,
      message: 'No file tab',
    });
    mocks.navigateToRegistryEntity.mockResolvedValue({
      status: 'presented',
      entityId: target.entityId,
    });
    await expect(
      execTool(limsOpenEntityTool, { entityId: target.entityId })
    ).resolves.toMatchObject({
      ok: true,
      status: 'registry-presented',
      entityId: target.entityId,
      presented: true,
    });
    expect(mocks.navigateToRegistryEntity).toHaveBeenCalledWith({
      entityId: target.entityId,
      fallbackSearch: target.label,
    });
  });

  it('explicitly presents a file-backed entity through the exact human Registry owner', async () => {
    const entity = makePlasmidEntity();
    mocks.getLimsEntityById.mockResolvedValue(entity);
    mocks.navigateToRegistryEntity.mockResolvedValue({ status: 'presented', entityId: entity.id });
    await expect(
      execTool(limsOpenEntityTool, { entityId: entity.id, presentation: 'registry' })
    ).resolves.toMatchObject({
      ok: true,
      status: 'registry-presented',
      entityId: entity.id,
      presented: true,
    });
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    expect(mocks.navigateToRegistryEntity).toHaveBeenCalledWith({
      entityId: entity.id,
      fallbackSearch: entity.name,
    });
  });

  it('refuses a missing explicit Registry target before changing presentation', async () => {
    mocks.getLimsEntityById.mockResolvedValue(null);
    await expect(
      execTool(limsOpenEntityTool, { entityId: 'missing', presentation: 'registry' })
    ).resolves.toMatchObject({
      ok: false,
      code: 'ENTITY_NOT_FOUND',
      stateChanged: false,
      partialEffects: [],
    });
    expect(mocks.navigateToRegistryEntity).not.toHaveBeenCalled();
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
  });

  it.each(['failed', 'superseded', 'timeout', 'blocked', 'app-not-ready', 'wrong-record'])(
    'refuses unacknowledged explicit Registry presentation: %s',
    async (status) => {
      const entity = makePlasmidEntity();
      mocks.getLimsEntityById.mockResolvedValue(entity);
      mocks.navigateToRegistryEntity.mockResolvedValue({
        status: status === 'wrong-record' ? 'presented' : status,
        entityId: status === 'wrong-record' ? 'foreign' : entity.id,
      });
      await expect(
        execTool(limsOpenEntityTool, { entityId: entity.id, presentation: 'registry' })
      ).resolves.toMatchObject({ ok: false });
      expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    }
  );

  it('retains strict opener validation and compatible document requests', () => {
    expect(limsOpenEntitySchema.parse({ entityId: 'record' })).toEqual({ entityId: 'record' });
    expect(
      limsOpenEntitySchema.parse({ entityId: 'record', presentation: 'document' }).presentation
    ).toBe('document');
    expect(
      limsOpenEntitySchema.safeParse({ entityId: 'record', presentation: 'invented' }).success
    ).toBe(false);
    expect(
      limsOpenEntitySchema.safeParse({
        entityId: 'record',
        presentation: 'registry',
        override: true,
      }).success
    ).toBe(false);
  });

  it.each(['failed', 'superseded', 'timeout', 'blocked', 'app-not-ready'])(
    'never reports a successful Registry open when the native presentation is %s',
    async (status) => {
      const target = { entityId: 'ws1::strain', label: 'Native strain', kind: 'record_detail' };
      mocks.openLimsEntity.mockResolvedValue({
        status: 'unsupported',
        target,
        message: 'No file tab',
      });
      mocks.navigateToRegistryEntity.mockResolvedValue({ status, entityId: target.entityId });
      await expect(
        execTool(limsOpenEntityTool, { entityId: target.entityId })
      ).resolves.toMatchObject({ ok: false });
    }
  );

  it('refuses a presentation acknowledgment for a different native record', async () => {
    const target = { entityId: 'ws1::strain', label: 'Native strain', kind: 'record_detail' };
    mocks.openLimsEntity.mockResolvedValue({
      status: 'unsupported',
      target,
      message: 'No file tab',
    });
    mocks.navigateToRegistryEntity.mockResolvedValue({
      status: 'presented',
      entityId: 'ws2::foreign',
    });
    await expect(
      execTool(limsOpenEntityTool, { entityId: target.entityId })
    ).resolves.toMatchObject({ ok: false });
  });
});
