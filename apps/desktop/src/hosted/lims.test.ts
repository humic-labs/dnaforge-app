// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { HostedCapabilityError } from './errors';
import { createHostedLims } from './lims';

describe('hosted LIMS', () => {
  it('starts empty and persists real registrations', async () => {
    const lims = createHostedLims();
    await expect(lims.queryEntities()).resolves.toEqual([]);
    const page = await lims.queryRegistrySummaries();
    expect(page.summaries).toEqual([]);
    expect(page.totalCount).toBe(0);

    const created = await lims.registerEntity({
      id: 'ws1::page-1',
      kind: 'notebook',
      name: 'Notes',
      fields: { packagePath: '/hosted/ws/Notes' },
      registrationStatus: 'registered',
    });
    expect(created.id).toBe('ws1::page-1');
    await expect(lims.queryEntities({ id: 'ws1::page-1' })).resolves.toEqual([
      expect.objectContaining({ id: 'ws1::page-1', kind: 'notebook', name: 'Notes' }),
    ]);
    const summaries = await lims.queryRegistrySummaries({ kind: 'notebook' });
    expect(summaries.totalCount).toBe(1);
    expect(summaries.summaries[0]?.representation.kind).toBe('notebook');
    await expect(lims.queryRegistrySummaries({ ids: [] })).resolves.toMatchObject({
      summaries: [],
      totalCount: 0,
    });
    await expect(lims.queryRegistrySummaries({ ids: ['ws1::page-1'] })).resolves.toMatchObject({
      totalCount: 1,
    });
  });

  it('refuses demo seeds instead of loading fixtures', async () => {
    const lims = createHostedLims();
    await expect(lims.seedDemoDataset()).rejects.toBeInstanceOf(HostedCapabilityError);
    await expect(lims.seedMockDemo()).rejects.toBeInstanceOf(HostedCapabilityError);
    await expect(lims.queryEntities()).resolves.toEqual([]);
  });

  it('counts schema-defined kinds while excluding archived registrations', async () => {
    const lims = createHostedLims();
    await lims.registerEntity({
      id: 'hosted-custom',
      kind: 'custom_specimen',
      name: 'Custom specimen',
      fields: {},
    });
    await lims.registerEntity({
      id: 'hosted-archived-custom',
      kind: 'custom_specimen',
      name: 'Archived specimen',
      fields: {},
    });
    await lims.archiveEntity({ id: 'hosted-archived-custom' });

    const counts = await lims.countEntitiesByKind();
    expect(counts.custom_specimen).toBe(1);
    expect(counts.oligo).toBe(0);
  });
});
