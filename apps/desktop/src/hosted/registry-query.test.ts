// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import type { LimsQueryRegistrySummariesInput } from '../shared/lims';
import { createHostedLims } from './lims';

const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';
const GAMMA = '33333333-3333-4333-8333-333333333333';
const day = (date: number) => new Date(2026, 10, date, 12).getTime();
let lims: ReturnType<typeof createHostedLims>;

beforeEach(async () => {
  lims = createHostedLims();
  const alpha = await lims.registerEntity({
    id: ALPHA,
    kind: 'oligo',
    name: 'Alpha primer',
    workspaceId: 1,
    createdAt: day(2),
    registrationStatus: 'registered',
    fields: {
      sequence: { mode: 'inline', bases: 'AAAATTTT', length: 8, topology: 'linear' },
      notes: 'fluorophore',
      tags: ['FLAG'],
      species: 'Escherichia coli',
      speciesTaxid: '511145',
    },
  });
  alpha.registryId = 'o000001';
  const beta = await lims.registerEntity({
    id: BETA,
    kind: 'strain',
    name: 'Beta strain',
    workspaceId: 2,
    createdAt: day(3),
    registrationStatus: 'tracked',
    domainStatus: 'ready',
    fields: { genotypeCanonical: 'his3D1', species: 'Vibrio cholerae', speciesTaxid: '666' },
  });
  beta.registryId = 's000002';
  const gamma = await lims.registerEntity({
    id: GAMMA,
    kind: 'plasmid',
    name: 'Gamma vector',
    workspaceId: 1,
    createdAt: day(4),
    registrationStatus: 'drifted',
    fields: {
      sequence: { mode: 'inline', bases: 'GGGGCCCC', length: 8, topology: 'circular' },
    },
  });
  gamma.registryId = 'p000003';
});

describe('hosted Registry query contract', () => {
  const cases: Array<{
    name: string;
    input: LimsQueryRegistrySummariesInput;
    ids: string[];
  }> = [
    { name: 'project ownership', input: { workspaceIds: [2] }, ids: [BETA] },
    { name: 'an empty project selection', input: { workspaceIds: [] }, ids: [] },
    { name: 'an exact identity list', input: { ids: [ALPHA] }, ids: [ALPHA] },
    { name: 'an empty identity list', input: { ids: [] }, ids: [] },
    { name: 'entity kind', input: { kind: 'oligo' }, ids: [ALPHA] },
    { name: 'multiple kinds', input: { kinds: ['oligo', 'strain'] }, ids: [BETA, ALPHA] },
    {
      name: 'multiple registration states',
      input: { registrationStatuses: ['registered', 'drifted'] },
      ids: [GAMMA, ALPHA],
    },
    { name: 'a domain state', input: { domainStatus: 'ready' }, ids: [BETA] },
    {
      name: 'an explicitly empty domain state',
      input: { domainStatus: null },
      ids: [GAMMA, ALPHA],
    },
    { name: 'species rank rollup', input: { speciesTaxids: ['562'] }, ids: [ALPHA] },
    { name: 'representation kind', input: { representationKind: 'strain_evidence' }, ids: [BETA] },
    { name: 'saved field text', input: { search: 'fluorophore' }, ids: [ALPHA] },
    { name: 'saved list values', input: { search: 'flag' }, ids: [ALPHA] },
    { name: 'an unpadded Registry ID', input: { search: 'O1' }, ids: [ALPHA] },
    { name: 'a Registry ID fragment', input: { registryIdLike: '000002' }, ids: [BETA] },
    { name: 'name text', input: { nameLike: 'ALPHA' }, ids: [ALPHA] },
    { name: 'sequence text', input: { sequenceLike: 'gggg' }, ids: [GAMMA] },
    {
      name: 'composed name and sequence filters',
      input: { nameLike: 'alpha', sequenceLike: 'gggg' },
      ids: [],
    },
    { name: 'one calendar day', input: { updatedOn: day(3) }, ids: [BETA] },
    { name: 'days after a boundary', input: { updatedAfter: day(2) }, ids: [GAMMA, BETA] },
    { name: 'days before a boundary', input: { updatedBefore: day(4) }, ids: [BETA, ALPHA] },
    { name: 'ascending names', input: { sort: 'name_asc' }, ids: [ALPHA, BETA, GAMMA] },
    { name: 'descending names', input: { sort: 'name_desc' }, ids: [GAMMA, BETA, ALPHA] },
  ];

  it.each(cases)('honors $name before returning its total', async ({ input, ids }) => {
    const page = await lims.queryRegistrySummaries(input);
    expect(page.summaries.map((entity) => entity.id)).toEqual(ids);
    expect(page.totalCount).toBe(ids.length);
  });

  it('filters and sorts before paging while preserving the complete matching count', async () => {
    const page = await lims.queryRegistrySummaries({
      workspaceIds: [1],
      sort: 'name_desc',
      limit: 1,
      offset: 1,
    });
    expect(page.summaries.map((entity) => entity.id)).toEqual([ALPHA]);
    expect(page).toMatchObject({ totalCount: 2, offset: 1, limit: 1 });
  });

  it.each([0, -1, 1.5])('rejects invalid project ID %s', async (id) => {
    await expect(lims.queryRegistrySummaries({ workspaceIds: [id] })).rejects.toThrow(
      'valid project IDs'
    );
  });

  it('excludes archived records unless explicitly requested', async () => {
    await lims.archiveEntity({ id: BETA });
    expect((await lims.queryRegistrySummaries({ ids: [BETA] })).summaries).toEqual([]);
    expect(
      (await lims.queryRegistrySummaries({ ids: [BETA], includeArchived: true })).summaries.map(
        (entity) => entity.id
      )
    ).toEqual([BETA]);
  });
});
