import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineBlob } from '@waypoint/workspace-revisions';
import type {
  LimsEntity,
  LimsUpdateEntityInput,
  ScientificStrainEditAuthority,
} from '../shared/lims';
import { ENTITY_ARTIFACT_SCHEMA } from '../features/lims/public/entity-artifact';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  query: vi.fn(),
  publish: vi.fn(),
  update: vi.fn(),
  begin: vi.fn(),
  end: vi.fn(),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: { beginWorkspaceMutation: mocks.begin, endWorkspaceMutation: mocks.end },
    scientificObjects: { read: mocks.read },
    lims: { queryEntities: mocks.query, updateEntity: mocks.update },
  }),
}));
vi.mock('../db/workspace-catalog', () => ({ resolveWorkspaceScope: async () => 'workspace:1' }));
vi.mock('./reconcile-accepted-workspace', () => ({
  reconcileAcceptedWorkspaceAfterFilesChanged: vi.fn(),
}));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [] }) },
}));
vi.mock('../features/scientific-document/services/read-scientific-text', () => ({
  readScientificText: vi.fn(),
}));
vi.mock('./entity-artifact-schema', () => ({
  resolveEntityArtifactSchemaFields: async () => [
    { key: 'genotypeCanonical', label: 'Canonical genotype', type: 'long_text', required: true },
  ],
}));
vi.mock('../features/workspace/public/git', () => ({
  isGitRepo: async () => false,
  gitStatus: vi.fn(),
  gitCommitPaths: vi.fn(),
}));
vi.mock('./publish-native-artifact', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./publish-native-artifact')>()),
  publishNativeArtifact: mocks.publish,
}));
import { NativeArtifactPublicationPendingError } from './publish-native-artifact';
import { updateAcceptedStrain } from './update-accepted-strain';

const native = {
  schema: ENTITY_ARTIFACT_SCHEMA,
  id: 'stock',
  kind: 'strain',
  name: 'BY4741 plan',
  fields: {
    genotypeCanonical: 'MATa ura3Δ0',
    unknownStockMetadata: { preserve: [true, { note: 'source record' }] },
  },
  registrationStatus: 'registered' as const,
  domainStatus: 'planned',
  source: {
    type: 'manual',
    values: { provenance: 'reference genotype' },
    unknownSource: ['keep', 7],
  },
  relationships: [
    {
      type: 'derives_from',
      fromEntityId: 'stock',
      toEntityId: 'parent',
      payload: { assertion: 'planned', note: 'unchanged target' },
      unknownRelationship: { keep: true },
    },
  ],
  unknownRoot: { preserve: ['future metadata', 2] },
};
const text = `${JSON.stringify(native, null, '\t')}\n\n`;
const authority: ScientificStrainEditAuthority = {
  workspaceRoot: '/w',
  workspaceId: 1,
  artifactPath: '/w/stock.entity.json',
  revision: {
    kind: 'accepted-object',
    resourceId: 'stock',
    resourceRevisionId: `rr_${'a'.repeat(64)}`,
    workspaceVersionId: `wv_${'b'.repeat(64)}`,
    contentSha256: defineBlob(new TextEncoder().encode(text)).hash.slice('sha256:'.length),
    sequenceEditParentEventId: null,
  },
};
const input = (): LimsUpdateEntityInput => ({
  id: 'stock',
  name: 'BY4741 hsp104 deletion plan',
  fields: { genotypeCanonical: 'MATa ura3Δ0 hsp104Δ' },
  expectedEventSeq: 9,
  operationId: 'unchanged-strain-field-intent',
});
const next = () => ({
  ...native,
  name: input().name,
  fields: { ...native.fields, ...input().fields },
});
const accepted = {
  ...authority.revision,
  resourceRevisionId: `rr_${'d'.repeat(64)}`,
  workspaceVersionId: `wv_${'e'.repeat(64)}`,
  contentSha256: defineBlob(
    new TextEncoder().encode(`${JSON.stringify(next(), null, 2)}\n`)
  ).hash.slice('sha256:'.length),
};
const projected = (): LimsEntity => ({
  id: 'stock',
  kind: 'strain',
  name: next().name!,
  fields: next().fields,
  schemaId: 'strain',
  schemaRevisionId: 'strain-v1',
  registryId: 's1',
  workspaceId: 1,
  registrationStatus: 'registered',
  domainStatus: 'planned',
  eventSeq: 12,
  actor: null,
  tombstone: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.begin.mockResolvedValue('owned-token');
  mocks.end.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({
    resourceId: 'stock',
    revisionId: authority.revision.resourceRevisionId,
    document: { kind: 'strain' },
    representation: { format: 'strain-entity-v1', text },
  });
  mocks.publish.mockResolvedValue(accepted);
  mocks.query.mockResolvedValue([projected()]);
});

describe('accepted strain field publication', () => {
  it('reads the captured immutable revision and preserves unknown data, provenance and planned relationships without an independent Registry write', async () => {
    await expect(updateAcceptedStrain(input(), authority)).resolves.toEqual(projected());
    expect(mocks.read).toHaveBeenCalledWith({
      workspaceRoot: '/w',
      request: {
        workspace: 'workspace:1',
        resourceId: 'stock',
        revisionId: authority.revision.resourceRevisionId,
      },
    });
    const proposal = mocks.publish.mock.calls[0][0];
    expect(proposal).toMatchObject({
      prior: authority.revision,
      artifactPath: authority.artifactPath,
      mutationToken: 'owned-token',
    });
    expect(JSON.parse(proposal.representation.text)).toEqual(next());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledWith('owned-token');
  });

  it('freezes both draft and captured authority before asynchronous reads', async () => {
    const supplied = input();
    const captured = { ...structuredClone(authority), revision: { ...authority.revision } };
    const saving = updateAcceptedStrain(supplied, captured);
    supplied.name = 'later unsaved draft';
    supplied.fields!.genotypeCanonical = 'later unsaved genotype';
    captured.artifactPath = '/later/other.entity.json';
    captured.revision.resourceRevisionId = `rr_${'f'.repeat(64)}`;
    await saving;
    expect(JSON.parse(mocks.publish.mock.calls[0][0].representation.text)).toEqual(next());
    expect(mocks.publish.mock.calls[0][0].prior).toEqual(authority.revision);
    expect(mocks.publish.mock.calls[0][0].artifactPath).toBe(authority.artifactPath);
  });

  it('retains accepted authority and does not query a success projection when delivery is blocked', async () => {
    mocks.publish.mockRejectedValue(
      new NativeArtifactPublicationPendingError(accepted, 'working bytes conflict.')
    );
    const error = await updateAcceptedStrain(input(), authority).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NativeArtifactPublicationPendingError);
    expect(error).toMatchObject({
      accepted,
      message: expect.stringContaining('working bytes conflict'),
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps the original immutable input and receipt intent for an unchanged retry after a required Registry query fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('Registry refresh unavailable'));
    const error = await updateAcceptedStrain(input(), authority).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      accepted,
      message: expect.stringContaining('Registry refresh unavailable'),
    });
    await expect(updateAcceptedStrain(input(), authority)).resolves.toEqual(projected());
    expect(mocks.publish.mock.calls[1]).toEqual(mocks.publish.mock.calls[0]);
    expect(mocks.read.mock.calls[1]).toEqual(mocks.read.mock.calls[0]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects an inconsistent captured byte hash without falling back to a working file', async () => {
    const captured = {
      ...authority,
      revision: { ...authority.revision, contentSha256: 'f'.repeat(64) },
    };
    await expect(updateAcceptedStrain(input(), captured)).rejects.toThrow(
      'captured strain revision'
    );
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['artifact', 'sourceMetadata'])(
    'rejects a field edit that changes reserved %s authority',
    async (key) => {
      await expect(
        updateAcceptedStrain({ ...input(), fields: { [key]: { changed: true } } }, authority)
      ).rejects.toThrow('provenance and file identity');
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );

  it('retains exact native formatting for an unchanged field Save', async () => {
    mocks.publish.mockResolvedValue(authority.revision);
    mocks.query.mockResolvedValue([{ ...projected(), name: native.name, fields: native.fields }]);
    await updateAcceptedStrain(
      {
        id: 'stock',
        name: native.name,
        fields: { genotypeCanonical: native.fields.genotypeCanonical },
      },
      authority
    );
    expect(mocks.publish.mock.calls[0][0].representation.text).toBe(text);
  });
});
